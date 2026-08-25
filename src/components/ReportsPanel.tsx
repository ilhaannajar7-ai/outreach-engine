'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { AnalyticsReport } from '@/lib/queries/analytics';

const PERIODS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** Health thresholds that actually matter for cold email deliverability. */
function bounceTone(rate: number): string {
  if (rate >= 5) return 'crit';
  if (rate >= 3) return 'warn';
  return 'good';
}
function replyTone(rate: number): string {
  if (rate >= 3) return 'good';
  if (rate >= 1) return 'warn';
  return 'neutral';
}
function reputationTone(score: number): string {
  if (score >= 70) return 'good';
  if (score >= 40) return 'warn';
  return 'crit';
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        padding: '13px 15px',
        background: 'var(--panel-2)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{ fontSize: 21, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
        className={tone ? `t-${tone}` : undefined}
      >
        {value}
      </div>
      {sub && (
        <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function ReportsPanel({ report }: { report: AnalyticsReport }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const active = Number(searchParams.get('days') ?? report.periodDays);

  const { funnel, database } = report;
  const nothingSentYet = funnel.sent === 0;

  return (
    <>
      {/* Period switcher + export */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        {PERIODS.map((p) => (
          <button
            key={p.days}
            className={`ctrl ${active === p.days ? 'primary' : ''}`}
            onClick={() => router.push(`/reports?days=${p.days}`)}
          >
            {p.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <a className="ctrl" href="/api/reports/export?period=weekly">
          ⬇ Weekly .xlsx
        </a>
        <a className="ctrl primary" href="/api/reports/export?period=monthly">
          ⬇ Monthly .xlsx
        </a>
      </div>

      {nothingSentYet && (
        <div className="banner" style={{ marginBottom: 16 }}>
          <span>
            No emails have been sent yet — the mailbox is still warming up. Sending figures below
            stay at zero until real outreach begins; warm-up filler is handled by Smartlead and is
            deliberately not counted here.
          </span>
        </div>
      )}

      {/* Headline funnel */}
      <div className="card">
        <div className="ch">
          <h3>Email performance</h3>
          <span className="hint">last {report.periodDays} days</span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))',
            gap: 10,
          }}
        >
          <Stat label="Approved" value={funnel.approved} sub="every send is human-approved" />
          <Stat label="Sent" value={funnel.sent} />
          <Stat
            label="Delivered"
            value={funnel.delivered}
            sub={funnel.sent ? pct(funnel.deliveryRate) : undefined}
          />
          <Stat
            label="Opened"
            value={funnel.opened}
            sub={funnel.sent ? `${pct(funnel.openRate)} · a floor, not exact` : undefined}
          />
          <Stat
            label="Replies"
            value={funnel.replied}
            sub={funnel.sent ? pct(funnel.replyRate) : undefined}
            tone={funnel.sent ? replyTone(funnel.replyRate) : undefined}
          />
          <Stat label="Interested" value={funnel.interested} sub="the number that pays" />
          <Stat
            label="Bounced"
            value={funnel.bounced}
            sub={funnel.sent ? `${pct(funnel.bounceRate)} · keep under 3%` : 'keep under 3%'}
            tone={funnel.sent ? bounceTone(funnel.bounceRate) : undefined}
          />
          <Stat
            label="Complaints"
            value={funnel.complained}
            sub="keep under 0.1%"
            tone={funnel.complaintRate >= 0.1 ? 'crit' : undefined}
          />
        </div>

        <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
          <strong>Reading these honestly.</strong> Open rate depends on a tracking pixel that many
          mail clients block, so the real figure is always higher than shown — judge campaigns on
          replies, not opens. Inbox-versus-spam placement cannot be measured from the sending side
          by any provider; reply rate is the honest proxy, and Smartlead&apos;s warm-up score is the
          closest direct signal.
        </div>
      </div>

      {/* Sending infrastructure */}
      <div className="card">
        <div className="ch">
          <h3>Mailboxes &amp; warm-up</h3>
          <span className="hint">{report.inboxes.length} inbox(es)</span>
        </div>
        {report.inboxes.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5 }}>
            No mailboxes registered yet.
          </p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Status</th>
                  <th>Reputation</th>
                  <th>Warm-up</th>
                  <th>Today</th>
                  <th>Total sent</th>
                  <th>Bounce %</th>
                </tr>
              </thead>
              <tbody>
                {report.inboxes.map((inbox) => (
                  <tr key={inbox.emailAddress}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {inbox.emailAddress}
                    </td>
                    <td>
                      <span className={`pill ${inbox.status === 'active' ? 'good' : 'neutral'}`}>
                        {inbox.status}
                      </span>
                    </td>
                    <td>
                      <span className={`pill ${reputationTone(inbox.reputationScore)}`}>
                        {inbox.reputationScore}/100
                      </span>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {inbox.warmupCompleted
                        ? 'complete'
                        : inbox.warmupDay
                          ? `day ${inbox.warmupDay}`
                          : 'not started'}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {inbox.sentToday} / {inbox.dailyLimit}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{inbox.totalSent}</td>
                    <td>
                      <span className={`pill ${bounceTone(inbox.bounceRate)}`}>
                        {pct(inbox.bounceRate)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AI spend */}
      <div className="card">
        <div className="ch">
          <h3>AI usage &amp; cost</h3>
          <span className="hint">${report.aiTotalCost.toFixed(4)} this period</span>
        </div>
        {report.aiSpend.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5 }}>
            No AI calls in this period.
          </p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Model</th>
                  <th>Calls</th>
                  <th>Input tokens</th>
                  <th>Output tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {report.aiSpend.map((row) => (
                  <tr key={`${row.operation}-${row.model}`}>
                    <td>{row.operation}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {row.model}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.calls}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {row.inputTokens.toLocaleString()}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {row.outputTokens.toLocaleString()}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      ${row.costUsd.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Third-party APIs */}
      <div className="card">
        <div className="ch">
          <h3>API usage</h3>
          <span className="hint">enrichment &amp; sourcing credits</span>
        </div>
        {report.apiUsage.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5 }}>
            No third-party API calls in this period.
          </p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Calls</th>
                  <th>Credits used</th>
                  <th>Failures</th>
                </tr>
              </thead>
              <tbody>
                {report.apiUsage.map((row) => (
                  <tr key={row.provider}>
                    <td style={{ fontWeight: 600 }}>{row.provider}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.calls}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.credits}</td>
                    <td>
                      <span className={`pill ${row.failures > 0 ? 'warn' : 'good'}`}>
                        {row.failures}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Database */}
      <div className="card">
        <div className="ch">
          <h3>Database</h3>
          <span className="hint">everything stored, all time</span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))',
            gap: 10,
          }}
        >
          <Stat
            label="Companies"
            value={database.companies}
            sub={`${database.sourcedCompanies} auto-sourced`}
          />
          <Stat label="Contacts" value={database.contacts} />
          <Stat label="Leads" value={database.leads} />
          <Stat label="Emails" value={database.emails} />
          <Stat label="Replies" value={database.replies} />
        </div>
      </div>
    </>
  );
}
