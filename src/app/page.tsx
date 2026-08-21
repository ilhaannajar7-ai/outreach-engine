import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import Link from 'next/link';
import { authOptions } from '@/lib/auth';
import { getDashboardData } from '@/lib/queries/dashboard';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { ActivityChart, FunnelChart, DonutChart, Sparkline } from '@/components/charts';
import { DomainPanel } from '@/components/DomainPanel';
import { formatStatus, statusPill, formatOperation, formatComponent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;
  const [data, unreadCount] = await Promise.all([getDashboardData(orgId, 14), getUnreadCount(orgId)]);

  const { kpis, activity, funnel, replyBreakdown, attention, infrastructure, health, budget, aiByOperation, capacity } =
    data;

  const downComponents = health.filter((h) => h.status === 'down');
  const healthState = downComponents.length > 0 ? 'down' : health.some((h) => h.status === 'degraded') ? 'degraded' : 'operational';

  const budgetClass = budget.isExceeded ? 'crit' : budget.isWarning ? 'warn' : '';

  return (
    <div className="shell">
      <Sidebar
        counts={{ leads: kpis.totalLeads, queue: kpis.pendingApproval, followUps: kpis.followUpsDue }}
        health={healthState}
      />

      <div className="main">
        <TopBar
          title="Dashboard"
          subtitle={`${session.user.organizationName} · last 14 days`}
          unreadCount={unreadCount}
        />

        <div className="content">
          {/* --- Alert banners -------------------------------------------- */}
          {budget.isExceeded && (
            <div className="banner crit">
              ⛔{' '}
              <span>
                <b>AI budget exhausted</b> — ${budget.spent.toFixed(2)} of the $
                {budget.stopAt.toFixed(2)} monthly cap used. AI operations are paused.{' '}
                <Link href="/settings/ai" className="act">
                  Adjust budget →
                </Link>
              </span>
            </div>
          )}

          {!budget.isExceeded && budget.isWarning && (
            <div className="banner">
              ⚠️{' '}
              <span>
                <b>AI budget at {budget.percentUsed.toFixed(0)}%</b> — ${budget.spent.toFixed(2)} of $
                {budget.stopAt.toFixed(2)} used. ${budget.remaining.toFixed(2)} remaining.{' '}
                <Link href="/settings/ai" className="act">
                  Review →
                </Link>
              </span>
            </div>
          )}

          {downComponents.length > 0 && (
            <div className="banner crit">
              ⛔{' '}
              <span>
                <b>
                  {downComponents.map((c) => c.component).join(', ')} not responding
                </b>{' '}
                — dependent work is paused.{' '}
                <Link href="/monitoring/health" className="act">
                  Open health →
                </Link>
              </span>
            </div>
          )}

          {kpis.pendingApproval > 0 && (
            <div className="banner good">
              ✉️{' '}
              <span>
                <b>{kpis.pendingApproval} draft{kpis.pendingApproval === 1 ? '' : 's'} awaiting your approval</b> —
                today&apos;s remaining send capacity is {capacity.remaining}.{' '}
                <Link href="/queue" className="act">
                  Review queue →
                </Link>
              </span>
            </div>
          )}

          {/* --- KPIs ------------------------------------------------------ */}
          <div className="kpis">
            <KpiCard label="Total leads" value={kpis.totalLeads} series={activity.map((a) => a.sent)} />
            <KpiCard label="Emails sent (14d)" value={kpis.emailsSent} series={activity.map((a) => a.sent)} />
            <KpiCard
              label="Reply rate"
              value={`${kpis.replyRate.toFixed(1)}%`}
              series={activity.map((a) => a.replies)}
              color="var(--violet)"
            />
            <KpiCard
              label="Interested"
              value={kpis.interested}
              series={activity.map((a) => a.replies)}
              color="var(--good)"
            />
            <KpiCard label="Meetings" value={kpis.meetingsBooked} series={[]} color="var(--muted)" />
            <KpiCard
              label="Needs attention"
              value={kpis.requiresAttention}
              series={[]}
              color="var(--warn)"
            />
          </div>

          {/* --- Charts ---------------------------------------------------- */}
          <div className="grid2">
            <div className="card">
              <div className="ch">
                <h3>Emails sent &amp; replies</h3>
                <span className="hint">last 14 days</span>
              </div>
              <ActivityChart data={activity} />
            </div>

            <div className="card">
              <div className="ch">
                <h3>Outreach funnel</h3>
                <span className="hint">this period</span>
              </div>
              <FunnelChart stages={funnel} />
            </div>
          </div>

          {/* --- Reply breakdown / AI cost / health ------------------------ */}
          <div className="grid3">
            <div className="card">
              <div className="ch">
                <h3>Reply breakdown</h3>
              </div>
              <DonutChart data={replyBreakdown} />
            </div>

            <div className="card">
              <div className="ch">
                <h3>AI usage &amp; cost</h3>
                <span className="hint">{budget.billingPeriod}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                  ${budget.spent.toFixed(2)}{' '}
                  <small style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 600 }}>
                    / ${budget.stopAt.toFixed(2)} cap
                  </small>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: budget.isExceeded ? 'var(--crit)' : budget.isWarning ? 'var(--warn)' : 'var(--muted)',
                  }}
                >
                  {budget.percentUsed.toFixed(0)}%
                </div>
              </div>
              <div className="track">
                <div className={`fill ${budgetClass}`} style={{ width: `${Math.min(100, budget.percentUsed)}%` }} />
                <div className="thresh" style={{ left: `${(budget.warnAt / budget.stopAt) * 100}%` }} />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                <span>◆ warn ${budget.warnAt.toFixed(0)}</span>
                <span>■ stop ${budget.stopAt.toFixed(0)}</span>
                <span style={{ marginLeft: 'auto' }}>{budget.callCount} calls</span>
              </div>

              <div
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: 'var(--muted)',
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: '5px 0',
                }}
              >
                {aiByOperation.length === 0 && <span>No AI calls yet this month.</span>}
                {aiByOperation.map((op) => (
                  <ContentsRow key={op.operation} label={formatOperation(op.operation)} value={`$${op.costUsd.toFixed(2)}`} />
                ))}
              </div>
            </div>

            <div className="card">
              <div className="ch">
                <h3>System health</h3>
                <span className="hint">live</span>
              </div>
              {health.length === 0 ? (
                <div className="empty">No health data yet — the worker records this every 10 minutes.</div>
              ) : (
                health.map((component) => (
                  <div className="hrow" key={component.id}>
                    <span className="hn">{formatComponent(component.component)}</span>
                    <span
                      className={`st ${
                        component.status === 'operational' ? 'ok' : component.status === 'degraded' ? 'warn' : 'err'
                      }`}
                    >
                      {component.status}
                    </span>
                  </div>
                ))
              )}
              <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--muted)' }}>
                Sending capacity today: <b style={{ color: 'var(--ink)' }}>{capacity.remaining}</b> of{' '}
                {capacity.globalLimit} across {capacity.inboxCount} inbox
                {capacity.inboxCount === 1 ? '' : 'es'}
              </div>
            </div>
          </div>

          {/* --- Sending infrastructure ------------------------------------ */}
          <DomainPanel domains={infrastructure} />

          {/* --- Leads requiring attention --------------------------------- */}
          <div className="card">
            <div className="ch">
              <h3>Leads requiring attention</h3>
              <span className="hint">{attention.length} items</span>
            </div>
            {attention.length === 0 ? (
              <div className="empty">Nothing needs you right now.</div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Contact</th>
                      <th>Status</th>
                      <th>Reason</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {attention.map((lead) => (
                      <tr key={lead.id}>
                        <td>{lead.companyName}</td>
                        <td>
                          {lead.contactName ?? lead.contactEmail}
                          {lead.contactTitle && (
                            <span className="muted"> · {lead.contactTitle}</span>
                          )}
                        </td>
                        <td>
                          <span className={`pill ${statusPill(lead.status)}`}>
                            {formatStatus(lead.status)}
                          </span>
                        </td>
                        <td className="muted">{lead.attentionReason ?? '—'}</td>
                        <td>
                          <Link href={`/leads/${lead.id}`} className="act">
                            Open →
                          </Link>
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

function KpiCard({
  label,
  value,
  series,
  color = 'var(--accent)',
}: {
  label: string;
  value: number | string;
  series: number[];
  color?: string;
}) {
  return (
    <div className="kpi">
      <div className="l">{label}</div>
      <div className="v">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <Sparkline points={series} color={color} />
    </div>
  );
}

function ContentsRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span>{label}</span>
      <span className="mono" style={{ color: 'var(--ink)' }}>
        {value}
      </span>
    </>
  );
}
