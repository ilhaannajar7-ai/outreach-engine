import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { leads, companies, contacts } from '@/db/schema';
import { and, eq, desc, sql as dsql } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { getBudgetStatus } from '@/lib/ai/budget';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { LeadsTable } from '@/components/LeadsTable';

export const dynamic = 'force-dynamic';

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; campaignId?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));
  const limit = 50;

  const conditions = [eq(leads.organizationId, orgId)];
  if (params.status && params.status !== 'all') {
    conditions.push(dsql`${leads.status} = ${params.status}`);
  }
  // Set when arriving from the Campaigns page. Validated as a UUID first — an
  // unparseable value would otherwise reach Postgres and error rather than
  // simply returning nothing.
  const campaignId =
    params.campaignId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.campaignId)
      ? params.campaignId
      : null;
  if (campaignId) conditions.push(eq(leads.campaignId, campaignId));

  const where = and(...conditions);

  const [rows, countRow, unreadCount, budget] = await Promise.all([
    db
      .select({
        id: leads.id,
        status: leads.status,
        followUpCount: leads.followUpCount,
        nextFollowUpAt: leads.nextFollowUpAt,
        requiresAttention: leads.requiresAttention,
        attentionReason: leads.attentionReason,
        researchId: leads.researchId,
        lastError: leads.lastError,
        createdAt: leads.createdAt,
        companyName: companies.name,
        companyDomain: companies.domain,
        companyIndustry: companies.industry,
        hiringSignal: companies.hiringSignal,
        contactName: contacts.fullName,
        contactEmail: contacts.email,
        contactTitle: contacts.jobTitle,
        emailVerified: contacts.emailVerified,
        isUnsubscribed: contacts.isUnsubscribed,
      })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(where)
      .orderBy(desc(leads.requiresAttention), desc(leads.updatedAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: dsql<number>`COUNT(*)::int` }).from(leads).where(where),
    getUnreadCount(orgId),
    getBudgetStatus(orgId),
  ]);

  const total = countRow[0]?.count ?? 0;

  return (
    <div className="shell">
      <Sidebar counts={{ leads: total }} />

      <div className="main">
        <TopBar
          title="Leads"
          subtitle={`${total} lead${total === 1 ? '' : 's'}`}
          unreadCount={unreadCount}
        />

        <div className="content">
          <LeadsTable
            leads={rows.map((r) => ({
              ...r,
              createdAt: r.createdAt.toISOString(),
              nextFollowUpAt: r.nextFollowUpAt?.toISOString() ?? null,
            }))}
            total={total}
            page={page}
            limit={limit}
            activeStatus={params.status ?? 'all'}
            campaignId={campaignId}
            budgetExceeded={budget.isExceeded}
          />
        </div>
      </div>
    </div>
  );
}
