import { z } from 'zod';
import { db } from '@/db';
import { companies, contacts } from '@/db/schema';
import { and, eq, isNull, sql as dsql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { requireWriteAccess, handleRoute, parseBody, audit, ApiError } from '@/lib/api-helpers';
import { getJobQueue } from '@/lib/providers/queue';

/**
 * Queue contact discovery.
 *
 * Either a single company, or every company that has a domain but no contact
 * yet. Runs through the worker so it is rate-limited, retried, and metered like
 * everything else — a discovery run cannot hammer Hunter synchronously from a
 * request.
 */
const bodySchema = z.object({
  companyId: z.string().uuid().optional(),
  campaignId: z.string().uuid().nullish(),
  /** Also research each company once its contact verifies. */
  thenResearch: z.boolean().default(false),
  /** Cap for the batch form, so one click can't queue thousands of credits. */
  limit: z.number().int().min(1).max(200).default(50),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const body = await parseBody(request, bodySchema);

    if (env.ENRICHMENT_PROVIDER === 'none') {
      throw new ApiError(
        400,
        'No enrichment provider is configured. Set ENRICHMENT_PROVIDER=hunter and HUNTER_API_KEY in .env.',
        'NO_PROVIDER',
      );
    }

    const queue = getJobQueue();

    // Single company.
    if (body.companyId) {
      const [company] = await db
        .select({ id: companies.id, name: companies.name, domain: companies.domain })
        .from(companies)
        .where(
          and(eq(companies.id, body.companyId), eq(companies.organizationId, ctx.organizationId)),
        )
        .limit(1);

      if (!company) throw new ApiError(404, 'Company not found', 'NOT_FOUND');
      if (!company.domain) {
        throw new ApiError(400, `${company.name} has no domain to search.`, 'NO_DOMAIN');
      }

      await queue.enqueue(
        'find_contacts',
        { companyId: company.id, campaignId: body.campaignId ?? null, thenResearch: body.thenResearch },
        { organizationId: ctx.organizationId, idempotencyKey: `find:${company.id}` },
      );

      await audit({
        ctx,
        action: 'enrichment.discover',
        entityType: 'company',
        entityId: company.id,
        metadata: { name: company.name },
        request,
      });

      return { queued: 1, company: company.name };
    }

    // Batch: companies with a domain but no contact.
    const targets = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .leftJoin(contacts, eq(contacts.companyId, companies.id))
      .where(
        and(
          eq(companies.organizationId, ctx.organizationId),
          dsql`${companies.domain} IS NOT NULL`,
          isNull(contacts.id),
        ),
      )
      .groupBy(companies.id, companies.name)
      .limit(body.limit);

    if (targets.length === 0) {
      return { queued: 0, message: 'Every company with a domain already has a contact.' };
    }

    for (const company of targets) {
      await queue.enqueue(
        'find_contacts',
        { companyId: company.id, campaignId: body.campaignId ?? null, thenResearch: body.thenResearch },
        { organizationId: ctx.organizationId, idempotencyKey: `find:${company.id}` },
      );
    }

    await audit({
      ctx,
      action: 'enrichment.discover_batch',
      entityType: 'company',
      metadata: { count: targets.length },
      request,
    });

    return {
      queued: targets.length,
      message:
        `Queued contact discovery for ${targets.length} compan${targets.length === 1 ? 'y' : 'ies'}. ` +
        'Each spends one Hunter search, then one verification once a contact is found.',
    };
  });
}
