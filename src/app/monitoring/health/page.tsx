import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { systemHealth, backgroundJobs } from '@/db/schema';
import { eq, desc, sql as dsql } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { formatComponent, formatStatus, formatRelativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [components, jobStats, recentFailures, unreadCount] = await Promise.all([
    db.select().from(systemHealth).orderBy(systemHealth.component),
    db
      .select({
        pending: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'pending')::int`,
        running: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'running')::int`,
        dead: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'dead')::int`,
        completed: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'completed')::int`,
      })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.organizationId, orgId)),
    db
      .select()
      .from(backgroundJobs)
      .where(dsql`${backgroundJobs.organizationId} = ${orgId} AND ${backgroundJobs.status} = 'dead'`)
      .orderBy(desc(backgroundJobs.completedAt))
      .limit(20),
    getUnreadCount(orgId),
  ]);

  const stats = jobStats[0] ?? { pending: 0, running: 0, dead: 0, completed: 0 };
  const anyDown = components.some((c) => c.status === 'down');

  return (
    <div className="shell">
      <Sidebar health={anyDown ? 'down' : 'operational'} />

      <div className="main">
        <TopBar
          title="System health"
          subtitle="Dependency status and background job queue"
          unreadCount={unreadCount}
        />

        <div className="content">
          {components.length === 0 && (
            <div className="banner">
              ℹ️{' '}
              <span>
                No health data recorded yet. The worker writes this every 10 minutes — if this stays
                empty, the worker container is not running.
              </span>
            </div>
          )}

          <div className="kpis">
            <StatCard label="Jobs pending" value={stats.pending} />
            <StatCard label="Running now" value={stats.running} />
            <StatCard label="Completed" value={stats.completed} />
            <StatCard label="Dead" value={stats.dead} tone={stats.dead > 0 ? 'crit' : undefined} />
          </div>

          <div className="card">
            <div className="ch">
              <h3>Dependencies</h3>
              <span className="hint">checked every 10 minutes</span>
            </div>

            {components.length === 0 ? (
              <div className="empty">Waiting for the first health check.</div>
            ) : (
              components.map((component) => (
                <div className="hrow" key={component.id}>
                  <span className="hn">{formatComponent(component.component)}</span>
                  <span className="muted mono" style={{ fontSize: 10.5 }}>
                    {component.responseTimeMs !== null ? `${component.responseTimeMs}ms` : ''}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {formatRelativeTime(component.lastCheckedAt)}
                  </span>
                  <span
                    className={`st ${
                      component.status === 'operational'
                        ? 'ok'
                        : component.status === 'degraded'
                          ? 'warn'
                          : 'err'
                    }`}
                  >
                    {component.status}
                  </span>
                </div>
              ))
            )}

            {components.some((c) => c.message && c.status !== 'operational') && (
              <div style={{ marginTop: 14 }}>
                <div className="seclabel">Errors</div>
                {components
                  .filter((c) => c.message && c.status !== 'operational')
                  .map((component) => (
                    <div
                      key={component.id}
                      className="banner crit"
                      style={{ marginBottom: 8, fontSize: 11.5, padding: '8px 12px' }}
                    >
                      <span>
                        <b>{formatComponent(component.component)}</b> ({component.consecutiveFailures}{' '}
                        consecutive failures): {component.message}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="ch">
              <h3>Failed jobs</h3>
              <span className="hint">
                {recentFailures.length} exhausted all retries
              </span>
            </div>

            {recentFailures.length === 0 ? (
              <div className="empty">
                No jobs have permanently failed. Transient errors are retried automatically with
                backoff.
              </div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Attempts</th>
                      <th>Failed</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentFailures.map((job) => (
                      <tr key={job.id}>
                        <td>{formatStatus(job.type)}</td>
                        <td className="mono">
                          {job.attempts}/{job.maxAttempts}
                        </td>
                        <td className="muted">
                          {job.completedAt ? formatRelativeTime(job.completedAt) : '—'}
                        </td>
                        <td className="muted" style={{ maxWidth: 380, fontSize: 11.5 }}>
                          {job.lastError ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <div className="ch">
              <h3>What recovers on its own</h3>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.75, color: 'var(--muted)' }}>
              <p style={{ marginTop: 0 }}>
                <b style={{ color: 'var(--ink)' }}>Rate limits and timeouts</b> — retried with
                exponential backoff up to 3 times. No action needed.
              </p>
              <p>
                <b style={{ color: 'var(--ink)' }}>A worker that dies mid-job</b> — the job is
                reclaimed after 10 minutes and runs again. Interrupted sends are re-queued.
              </p>
              <p style={{ marginBottom: 0 }}>
                <b style={{ color: 'var(--ink)' }}>What does not auto-recover</b> — an invalid API
                key, an exhausted budget, or a provider blocking the account. These stop the relevant
                work and email you, because the correct response is a decision, not a retry.
              </p>
            </div>
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
