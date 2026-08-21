import { z } from 'zod';
import { db } from '@/db';
import { sendingDomains, sendingInboxes } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { checkAllDns } from '@/lib/sending/dns-check';
import { getSendingInfrastructure } from '@/lib/queries/dashboard';
import {
  requireAuth,
  requireAdmin,
  handleRoute,
  parseBody,
  audit,
  ApiError,
} from '@/lib/api-helpers';

export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    return { domains: await getSendingInfrastructure(ctx.organizationId) };
  });
}

const createSchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(255)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'Not a valid domain'),
  maxDailySendLimit: z.number().int().min(1).max(1000).default(200),
  warmupDurationDays: z.number().int().min(7).max(90).default(42),
  /** Start warm-up now. Leave false until the DNS records are actually in place. */
  startWarmup: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});

/**
 * Add a sending domain. This is the "scale up" action — it is an insert plus a
 * DNS check, which is why growing from 1 to 5 domains needs no deploy.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, createSchema);

    const domain = body.domain.toLowerCase().trim();

    const [existing] = await db
      .select({ id: sendingDomains.id })
      .from(sendingDomains)
      .where(eq(sendingDomains.domain, domain))
      .limit(1);

    if (existing) {
      throw new ApiError(409, `${domain} is already configured.`, 'DUPLICATE_DOMAIN');
    }

    const dns = await checkAllDns(domain);

    const [created] = await db
      .insert(sendingDomains)
      .values({
        organizationId: ctx.organizationId,
        domain,
        status: body.startWarmup && dns.allPassing ? 'warming' : 'pending_dns',
        spfStatus: dns.spf.status,
        dkimStatus: dns.dkim.status,
        dmarcStatus: dns.dmarc.status,
        dnsLastCheckedAt: new Date(),
        dnsRecords: {
          spf: dns.spf.record ?? '',
          dkim: dns.dkim.record ?? '',
          dmarc: dns.dmarc.record ?? '',
          mx: dns.mx.record ?? '',
        },
        warmupStartedAt: body.startWarmup && dns.allPassing ? new Date() : null,
        warmupDurationDays: body.warmupDurationDays,
        dailySendLimit: 20,
        maxDailySendLimit: body.maxDailySendLimit,
        notes: body.notes ?? null,
      })
      .returning();

    await audit({
      ctx,
      action: 'domain.create',
      entityType: 'sending_domain',
      entityId: created!.id,
      metadata: { domain, dnsPassing: dns.allPassing },
      request,
    });

    return {
      domain: created,
      dns,
      nextStep: dns.allPassing
        ? body.startWarmup
          ? 'Warm-up started. Add inboxes for this domain next.'
          : 'DNS is correct. Add inboxes, then start warm-up.'
        : 'Add the missing DNS records, then re-check from this page. Warm-up cannot start until SPF, DKIM, and DMARC pass.',
    };
  });
}
