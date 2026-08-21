import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { backgroundJobs } from '@/db/schema';
import { and, eq, desc, sql as dsql } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { formatStatus, formatRelativeTime } from '@/lib/format';
import { JobRetryButton } from '@/components/JobRetryButton';

export const dynamic = 'force-dynamic';

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;
  const params = await searchParams;
  const filter = params.status ?? 'all';

  const conditions = [eq(backgroundJobs.organizationId, orgId)];
  if (filter !== 'all') conditions.push(dsql`${backgroundJobs.status} = ${filter}`);

  const [jobs, stats, unreadCount] = await Promise.all([
    db
      .select()
      .from(backgroundJobs)
      .where(and(...conditions))
      .orderBy(desc(backgroundJobs.createdAt))
      .limit(100),
    db
      .select({
        pending: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'pending')::int`,
        running: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'running')::int`,
        completed: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'completed')::int`,
        dead: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'dead')::int`,
      })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.organizationId, orgId)),
    getUnreadCount(orgId),
  ]);

  const s = stats[0] ?? { pending: 0, running: 0, completed: 0, dead: 0 };

  const FILTERS = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: `Pending (${s.pending})` },
    { value: 'running', label: `Running (${s.running})` },
    { value: 'completed', label: 'Completed' },
    { value: 'dead', label: `Dead (${s.dead})` },
  ];

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Background jobs"
          subtitle="Everything the worker is doing, has done, or gave up on"
          unreadCount={unreadCount}
        />

        <div className="content">
          <div className="kpis">
            <StatCard label="Pending" value={s.pending} />
            <StatCard label="Running" value={s.running} />
            <StatCard label="Completed" value={s.completed} />
            <StatCard label="Dead" value={s.dead} tone={s.dead > 0 ? 'crit' : undefined} />
          </div>

          {s.pending > 50 && (
            <div className="banner">
              ⚠️{' '}
              <span>
                <b>{s.pending} jobs queued.</b> If this keeps climbing, the worker container may not
                be running — check <code>docker compose ps</code>.
              </span>
            </div>
          )}

          <div className="card">
            <div className="ch">
              <h3>Job queue</h3>
              <span className="hint">showing {jobs.length}</span>
            </div>

            <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 6 }}>
              {FILTERS.map((f) => (
                <a
                  key={f.value}
                  href={f.value === 'all' ? '/monitoring/jobs' : `/monitoring/jobs?status=${f.value}`}
                  className={`ctrl sm ${filter === f.value ? 'primary' : ''}`}
                >
                  {f.label}
                </a>
              ))}
            </div>

            {jobs.length === 0 ? (
              <div className="empty">
                No jobs here. The worker schedules health checks and follow-up sweeps automatically —
                if this stays empty entirely, the worker is not running.
              </div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Created</th>
                      <th>Duration</th>
                      <th>Error</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr key={job.id}>
                        <td style={{ fontWeight: 600 }}>{formatStatus(job.type)}</td>
                        <td>
                          <span className={`pill ${jobPill(job.status)}`}>{job.status}</span>
                        </td>
                        <td className="mono">
                          {job.attempts}/{job.maxAttempts}
                        </td>
                        <td className="muted">{formatRelativeTime(job.createdAt)}</td>
                        <td className="mono muted">
                          {job.durationMs !== null ? `${(job.durationMs / 1000).toFixed(1)}s` : '—'}
                        </td>
                        <td
                          className="muted"
                          style={{ maxWidth: 300, fontSize: 11.5, wordBreak: 'break-word' }}
                        >
                          {job.lastError ?? '—'}
                        </td>
                        <td>
                          {job.status === 'dead' && <JobRetryButton jobId={job.id} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'crit' }) {
  return (
    <div className="kpi">
      <div className="l">{label}</div>
      <div className="v" style={tone === 'crit' && value > 0 ? { color: 'var(--crit)' } : undefined}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function jobPill(status: string): string {
  return (
    {
      completed: 'good',
      running: 'fu',
      pending: 'new',
      dead: 'crit',
      failed: 'crit',
      cancelled: 'neutral',
    }[status] ?? 'neutral'
  );
}
