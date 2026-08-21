import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { auditLogs, users } from '@/db/schema';
import { and, eq, desc, sql as dsql } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { formatRelativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const ACTION_LABELS: Record<string, string> = {
  'lead.create': 'Created a lead',
  'lead.update': 'Updated a lead',
  'lead.import': 'Imported leads',
  'lead.research': 'Queued research',
  'lead.generate_email': 'Queued email generation',
  'email.approve': 'Approved an email',
  'email.reject': 'Rejected an email',
  'email.bulk_approve': 'Bulk-approved emails',
  'domain.create': 'Added a sending domain',
  'domain.update': 'Updated a domain',
  'domain.delete': 'Deleted a domain',
  'domain.verify_dns': 'Re-checked DNS',
  'inbox.create': 'Added an inbox',
  'inbox.update': 'Updated an inbox',
  'inbox.retire': 'Retired an inbox',
  'inbox.delete': 'Deleted an inbox',
  'settings.ai_update': 'Changed AI configuration',
  'settings.prompt_update': 'Edited a prompt',
  'settings.prompt_revert': 'Reverted a prompt',
  'settings.organization': 'Updated organization details',
  'campaign.create': 'Created a campaign',
  'campaign.update': 'Updated a campaign',
  'campaign.delete': 'Deleted a campaign',
  'job.retry': 'Retried a failed job',
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; entityType?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));
  const limit = 75;

  const conditions = [eq(auditLogs.organizationId, orgId)];
  if (params.entityType) conditions.push(eq(auditLogs.entityType, params.entityType));
  const where = and(...conditions);

  const [entries, countRow, unreadCount] = await Promise.all([
    db
      .select({
        log: auditLogs,
        userName: users.name,
        userEmail: users.email,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: dsql<number>`COUNT(*)::int` }).from(auditLogs).where(where),
    getUnreadCount(orgId),
  ]);

  const total = countRow[0]?.count ?? 0;
  const totalPages = Math.ceil(total / limit);

  const ENTITY_FILTERS = [
    { value: '', label: 'All' },
    { value: 'lead', label: 'Leads' },
    { value: 'email', label: 'Emails' },
    { value: 'sending_domain', label: 'Domains' },
    { value: 'sending_inbox', label: 'Inboxes' },
    { value: 'ai_config', label: 'AI config' },
    { value: 'ai_prompt', label: 'Prompts' },
    { value: 'campaign', label: 'Campaigns' },
  ];

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Audit log"
          subtitle={`${total.toLocaleString()} recorded action${total === 1 ? '' : 's'}`}
          unreadCount={unreadCount}
        />

        <div className="content">
          <div className="card">
            <div className="ch">
              <h3>Every change, who made it, and when</h3>
              <span className="hint">newest first</span>
            </div>

            <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 6 }}>
              {ENTITY_FILTERS.map((f) => (
                <a
                  key={f.value}
                  href={f.value ? `/monitoring/audit?entityType=${f.value}` : '/monitoring/audit'}
                  className={`ctrl sm ${(params.entityType ?? '') === f.value ? 'primary' : ''}`}
                >
                  {f.label}
                </a>
              ))}
            </div>

            {entries.length === 0 ? (
              <div className="empty">
                Nothing recorded yet. Every approval, setting change, and import is logged here.
              </div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Who</th>
                      <th>Action</th>
                      <th>Details</th>
                      <th>IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(({ log, userName, userEmail }) => (
                      <tr key={log.id}>
                        <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                          {formatRelativeTime(log.createdAt)}
                        </td>
                        <td>{userName ?? userEmail ?? <span className="muted">system</span>}</td>
                        <td style={{ fontWeight: 600 }}>{ACTION_LABELS[log.action] ?? log.action}</td>
                        <td className="muted" style={{ maxWidth: 340, fontSize: 11.5 }}>
                          {summarize(log.metadata, log.changes)}
                        </td>
                        <td className="mono muted" style={{ fontSize: 10.5 }}>
                          {log.ipAddress ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {totalPages > 1 && (
              <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
                {page > 1 && (
                  <a
                    href={`/monitoring/audit?page=${page - 1}${params.entityType ? `&entityType=${params.entityType}` : ''}`}
                    className="ctrl sm"
                  >
                    ← Previous
                  </a>
                )}
                <span className="muted mono" style={{ fontSize: 11.5 }}>
                  Page {page} of {totalPages}
                </span>
                {page < totalPages && (
                  <a
                    href={`/monitoring/audit?page=${page + 1}${params.entityType ? `&entityType=${params.entityType}` : ''}`}
                    className="ctrl sm"
                  >
                    Next →
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Render the JSON blobs as a short human sentence rather than raw objects. */
function summarize(metadata: unknown, changes: unknown): string {
  const source = (metadata ?? changes) as Record<string, unknown> | null;
  if (!source || typeof source !== 'object') return '—';

  const parts = Object.entries(source)
    .filter(([key]) => key !== 'jobId')
    .slice(0, 4)
    .map(([key, value]) => {
      const label = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase();
      if (value === null || value === undefined) return null;
      if (typeof value === 'boolean') return value ? label : null;
      if (typeof value === 'object') return `${label}: ${JSON.stringify(value).slice(0, 40)}`;
      return `${label}: ${String(value).slice(0, 60)}`;
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join(' · ') : '—';
}
