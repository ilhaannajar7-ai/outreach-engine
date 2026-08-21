import { db } from '@/db';
import { sendingDomains } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { checkAllDns } from '@/lib/sending/dns-check';
import { requireWriteAccess, handleRoute, audit, ApiError } from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

/** Re-run DNS checks now. Wired to the "Re-check DNS" button on the dashboard. */
export async function POST(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;

    const [domain] = await db
      .select()
      .from(sendingDomains)
      .where(and(eq(sendingDomains.id, id), eq(sendingDomains.organizationId, ctx.organizationId)))
      .limit(1);

    if (!domain) throw new ApiError(404, 'Domain not found', 'NOT_FOUND');

    const dns = await checkAllDns(domain.domain);

    // A domain parked in pending_dns becomes eligible the moment DNS is right.
    const shouldPromote = dns.allPassing && domain.status === 'pending_dns';

    const [updated] = await db
      .update(sendingDomains)
      .set({
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
        ...(shouldPromote ? { status: 'warming' as const, warmupStartedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sendingDomains.id, id))
      .returning();

    await audit({
      ctx,
      action: 'domain.verify_dns',
      entityType: 'sending_domain',
      entityId: id,
      metadata: { allPassing: dns.allPassing, promoted: shouldPromote },
      request,
    });

    return {
      domain: updated,
      dns,
      promoted: shouldPromote,
      message: shouldPromote
        ? 'All DNS records pass. Warm-up has started automatically.'
        : dns.allPassing
          ? 'All DNS records pass.'
          : 'Some records are still missing or incorrect — see the details below.',
    };
  });
}
