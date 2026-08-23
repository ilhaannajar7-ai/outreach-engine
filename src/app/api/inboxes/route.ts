import { z } from 'zod';
import { db } from '@/db';
import { sendingInboxes, sendingDomains } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  requireAuth,
  requireAdmin,
  handleRoute,
  parseBody,
  audit,
  ApiError,
} from '@/lib/api-helpers';
import { env } from '@/lib/env';

export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();

    const rows = await db
      .select({
        inbox: sendingInboxes,
        domain: sendingDomains.domain,
        domainStatus: sendingDomains.status,
      })
      .from(sendingInboxes)
      .innerJoin(sendingDomains, eq(sendingInboxes.domainId, sendingDomains.id))
      .where(eq(sendingInboxes.organizationId, ctx.organizationId))
      .orderBy(sendingInboxes.emailAddress);

    return { inboxes: rows };
  });
}

const createSchema = z.object({
  domainId: z.string().uuid(),
  localPart: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, 'Use only letters, numbers, dots, dashes, and underscores'),
  displayName: z.string().min(1).max(255),
  replyToAddress: z.string().email().max(320).optional(),
  // Defaults to the app's configured EMAIL_PROVIDER when the caller omits it,
  // so a new inbox uses whatever the deployment actually sends through.
  provider: z.enum(['resend', 'smartlead', 'smtp', 'console']).optional(),
  providerInboxId: z.string().max(255).optional(),
  maxDailySendLimit: z.number().int().min(1).max(500).default(50),
  startWarmup: z.boolean().default(true),
});

/** Add a mailbox to a domain. Sends distribute across all active inboxes. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, createSchema);

    const [domain] = await db
      .select()
      .from(sendingDomains)
      .where(
        and(
          eq(sendingDomains.id, body.domainId),
          eq(sendingDomains.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);

    if (!domain) throw new ApiError(404, 'Domain not found', 'NOT_FOUND');

    const emailAddress = `${body.localPart.toLowerCase()}@${domain.domain}`;

    const [existing] = await db
      .select({ id: sendingInboxes.id })
      .from(sendingInboxes)
      .where(eq(sendingInboxes.emailAddress, emailAddress))
      .limit(1);

    if (existing) {
      throw new ApiError(409, `${emailAddress} already exists.`, 'DUPLICATE_INBOX');
    }

    // A new inbox always starts at 10/day regardless of what the domain is at.
    // Mailbox reputation is per-address, not per-domain.
    const startsWarming = body.startWarmup && domain.spfStatus === 'pass';

    const [created] = await db
      .insert(sendingInboxes)
      .values({
        organizationId: ctx.organizationId,
        domainId: body.domainId,
        emailAddress,
        displayName: body.displayName,
        replyToAddress: body.replyToAddress ?? null,
        provider: body.provider ?? env.EMAIL_PROVIDER,
        providerInboxId: body.providerInboxId ?? null,
        status: startsWarming ? 'warming' : 'pending_setup',
        dailySendLimit: 10,
        maxDailySendLimit: body.maxDailySendLimit,
        warmupStartedAt: startsWarming ? new Date() : null,
        reputationScore: 50,
      })
      .returning();

    await audit({
      ctx,
      action: 'inbox.create',
      entityType: 'sending_inbox',
      entityId: created!.id,
      metadata: { emailAddress, provider: body.provider },
      request,
    });

    return {
      inbox: created,
      message: startsWarming
        ? `${emailAddress} added and warming. It starts at 10 emails/day and ramps to ${body.maxDailySendLimit}/day over about 6 weeks.`
        : `${emailAddress} added but not sending yet — the domain's DNS must pass first.`,
    };
  });
}
