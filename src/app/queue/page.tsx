import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { emails, leads, companies, contacts } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { getRemainingCapacityToday } from '@/lib/sending/inbox-rotation';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { ApprovalQueue } from '@/components/ApprovalQueue';

export const dynamic = 'force-dynamic';

export default async function QueuePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [drafts, unreadCount, capacity] = await Promise.all([
    db
      .select({
        id: emails.id,
        kind: emails.kind,
        subject: emails.subject,
        bodyText: emails.bodyText,
        toAddress: emails.toAddress,
        model: emails.model,
        costUsd: emails.costUsd,
        createdAt: emails.createdAt,
        wasEditedByHuman: emails.wasEditedByHuman,
        leadId: leads.id,
        companyName: companies.name,
        companyDomain: companies.domain,
        companyIndustry: companies.industry,
        hiringSignal: companies.hiringSignal,
        contactName: contacts.fullName,
        contactTitle: contacts.jobTitle,
        contactEmail: contacts.email,
        emailVerified: contacts.emailVerified,
      })
      .from(emails)
      .innerJoin(leads, eq(emails.leadId, leads.id))
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(and(eq(emails.organizationId, orgId), eq(emails.status, 'pending_approval')))
      .orderBy(desc(emails.createdAt))
      .limit(100),
    getUnreadCount(orgId),
    getRemainingCapacityToday(orgId),
  ]);

  return (
    <div className="shell">
      <Sidebar counts={{ queue: drafts.length }} />

      <div className="main">
        <TopBar
          title="Approval queue"
          subtitle={`${drafts.length} draft${drafts.length === 1 ? '' : 's'} waiting · ${capacity.remaining} sends available today`}
          unreadCount={unreadCount}
          refreshAutoSeconds={60}
        />

        <div className="content">
          <ApprovalQueue
            drafts={drafts.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))}
            capacityToday={capacity.remaining}
          />
        </div>
      </div>
    </div>
  );
}
