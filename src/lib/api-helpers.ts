/**
 * Shared helpers for API routes.
 *
 * Every route uses `requireAuth` before touching data. The returned context
 * carries the organizationId, which every query must be scoped by — that scope
 * is the tenant boundary, and forgetting it is the one bug class this file
 * exists to prevent.
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions, canWrite, canAdmin } from '@/lib/auth';
import { db } from '@/db';
import { auditLogs } from '@/db/schema';

export interface AuthContext {
  userId: string;
  organizationId: string;
  organizationName: string;
  role: string;
  email: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function requireAuth(): Promise<AuthContext> {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id || !session.user.organizationId) {
    throw new ApiError(401, 'Authentication required', 'UNAUTHENTICATED');
  }

  return {
    userId: session.user.id,
    organizationId: session.user.organizationId,
    organizationName: session.user.organizationName,
    role: session.user.role,
    email: session.user.email ?? '',
  };
}

export async function requireWriteAccess(): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!canWrite(ctx.role)) {
    throw new ApiError(403, 'Your role does not permit this action', 'FORBIDDEN');
  }
  return ctx;
}

export async function requireAdmin(): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!canAdmin(ctx.role)) {
    throw new ApiError(403, 'Administrator access required', 'FORBIDDEN');
  }
  return ctx;
}

/**
 * Wrap a route handler so every failure becomes a consistent JSON response and
 * nothing leaks a stack trace to the client.
 */
export function handleRoute<T>(handler: () => Promise<T>): Promise<NextResponse> {
  return handler()
    .then((data) => NextResponse.json({ ok: true, data }))
    .catch((error) => {
      if (error instanceof ApiError) {
        return NextResponse.json(
          { ok: false, error: error.message, code: error.code },
          { status: error.status },
        );
      }

      if (error instanceof z.ZodError) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Invalid request',
            code: 'VALIDATION_ERROR',
            issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          { status: 400 },
        );
      }

      // Named errors from the domain layer carry messages written for humans,
      // so they are safe and useful to pass through.
      const name = (error as { name?: string })?.name;
      if (
        name === 'BudgetExceededError' ||
        name === 'NoCapacityError' ||
        name === 'EnrichmentQuotaError'
      ) {
        return NextResponse.json(
          { ok: false, error: (error as Error).message, code: name },
          { status: 409 },
        );
      }

      console.error('[api] unhandled error:', error);
      return NextResponse.json(
        { ok: false, error: 'Internal server error', code: 'INTERNAL_ERROR' },
        { status: 500 },
      );
    });
}

/**
 * Parse and validate a JSON body, throwing a 400 on malformed input.
 *
 * The schema's input type is `unknown` rather than `T`: schemas here use
 * `.default()` and coercion, so what they accept differs from what they emit,
 * and `T` must bind to the emitted type.
 */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON', 'INVALID_JSON');
  }
  return schema.parse(raw);
}

/** Same as parseBody, for querystring parameters. */
export function parseQuery<T>(request: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  return schema.parse(params);
}

/**
 * Parse an optional JSON body. Returns the schema's defaults when the request
 * carries no body at all, which is the common case for action endpoints.
 */
export async function parseOptionalBody<T>(
  request: Request,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  try {
    const raw = await request.json();
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    return schema.parse({});
  }
}

/** Append to the audit trail. Never throws — auditing must not break the action. */
export async function audit(params: {
  ctx: AuthContext;
  action: string;
  entityType: string;
  entityId?: string;
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  request?: Request;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      organizationId: params.ctx.organizationId,
      userId: params.ctx.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      changes: params.changes ?? null,
      metadata: params.metadata ?? null,
      ipAddress:
        params.request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        params.request?.headers.get('x-real-ip') ??
        null,
      userAgent: params.request?.headers.get('user-agent') ?? null,
    });
  } catch (error) {
    console.error('[audit] failed to write audit log:', error);
  }
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function paginationOffset(p: Pagination): number {
  return (p.page - 1) * p.limit;
}
