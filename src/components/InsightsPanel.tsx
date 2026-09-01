'use client';

/**
 * Weekly performance analysis.
 *
 * The figures are computed in SQL and the significance verdicts come from the
 * experiment maths — the model only interprets. That separation is visible in
 * the layout: numbers and verdicts are presented as fact, the written analysis
 * is clearly labelled as the model's reading of them.
 */

import { useCallback, useEffect, useState } from 'react';

interface Campaign {
  campaignName: string;
  sent: number;
  opened: number;
  replied: number;
  interested: number;
  bounced: number;
  openRate: number;
  replyRate: number;
}

interface Variant {
  name: string;
  campaignName: string;
  isControl: boolean;
  sent: number;
  replied: number;
  replyRate: number;
  verdict: string;
  explanation: string;
}

interface Report {
  generatedAt: string;
  periodDays: number;
  totals: {
    sent: number;
    opened: number;
    replied: number;
    interested: number;
    bounced: number;
    replyRate: number;
  };
  campaigns: Campaign[];
  variants: Variant[];
  analysis?: {
    headline: string;
    whatIsWorking: string[];
    whatIsNot: string[];
    recommendations: string[];
    confidence: string;
  };
  significantWinner: { name: string; replyRate: number; explanation: string } | null;
  note: string;
}

export function InsightsPanel({ canEdit }: { canEdit: boolean }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/insights', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok) setReport(json.data.report);
      else setError(json.error);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function regenerate() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/insights', { method: 'POST' });
      const json = await res.json();
      if (json.ok) setReport(json.data.report);
      else setError(json.error);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <div className="card"><div className="empty">Loading…</div></div>;

  return (
    <>
      {error && (
        <div className="banner crit">
          <span>{error}</span>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>Weekly performance analysis</h3>
          <span className="hint">
            {report ? `generated ${new Date(report.generatedAt).toLocaleString()}` : 'not generated yet'}
          </span>
          {canEdit && (
            <button className="ctrl sm primary" onClick={() => void regenerate()} disabled={running}>
              {running ? <span className="spin" /> : 'Run analysis now'}
            </button>
          )}
        </div>

        {!report ? (
          <div className="empty">
            No report yet. It runs automatically every Monday — or generate one now.
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                gap: 10,
                marginBottom: 14,
              }}
            >
              <Stat label="Sent" value={report.totals.sent} />
              <Stat label="Opened" value={report.totals.opened} />
              <Stat
                label="Replied"
                value={report.totals.replied}
                sub={`${report.totals.replyRate.toFixed(1)}%`}
                color="var(--good)"
              />
              <Stat label="Interested" value={report.totals.interested} color="var(--good)" />
              <Stat
                label="Bounced"
                value={report.totals.bounced}
                color={report.totals.bounced > 0 ? 'var(--crit)' : 'var(--muted)'}
              />
            </div>

            {report.analysis && (
              <div
                style={{
                  border: '1px solid var(--line)',
                  borderLeft: '3px solid var(--accent)',
                  borderRadius: 10,
                  padding: 14,
                  background: 'var(--panel-2)',
                  marginBottom: 14,
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 10 }}>
                  {report.analysis.headline}
                </div>

                <Section title="What's working" items={report.analysis.whatIsWorking} tone="good" />
                <Section title="What's not" items={report.analysis.whatIsNot} tone="crit" />
                <Section
                  title="Recommended next"
                  items={report.analysis.recommendations}
                  tone="accent"
                />

                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.6 }}>
                  <b>Confidence:</b> {report.analysis.confidence}
                  <br />
                  Written by the model from the figures above. The winner verdict below is decided
                  by a statistical test, not by the model.
                </div>
              </div>
            )}

            {report.significantWinner ? (
              <div className="banner good" style={{ marginBottom: 14 }}>
                🏆{' '}
                <span>
                  <b>{report.significantWinner.name}</b> is a statistically significant winner at{' '}
                  {report.significantWinner.replyRate.toFixed(1)}% reply rate.{' '}
                  {report.significantWinner.explanation}
                </span>
              </div>
            ) : (
              <div className="banner" style={{ marginBottom: 14 }}>
                ℹ️ <span>{report.note}</span>
              </div>
            )}

            {report.campaigns.length > 0 && (
              <>
                <div className="seclabel">By campaign (last {report.periodDays} days)</div>
                <div className="tablewrap" style={{ marginBottom: 14 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Sent</th>
                        <th>Opened</th>
                        <th>Replied</th>
                        <th>Reply rate</th>
                        <th>Bounced</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.campaigns.map((c) => (
                        <tr key={c.campaignName}>
                          <td style={{ fontWeight: 600 }}>{c.campaignName}</td>
                          <td>{c.sent}</td>
                          <td>{c.opened}</td>
                          <td>{c.replied}</td>
                          <td className="mono">{c.replyRate.toFixed(1)}%</td>
                          <td style={{ color: c.bounced > 0 ? 'var(--crit)' : undefined }}>
                            {c.bounced}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {report.variants.length > 0 && (
              <>
                <div className="seclabel">By strategy variant (all time)</div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th>Sent</th>
                        <th>Replied</th>
                        <th>Reply rate</th>
                        <th>Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.variants.map((v) => (
                        <tr key={v.name}>
                          <td style={{ fontWeight: 600 }}>
                            {v.name}
                            {v.isControl && <span className="muted"> (control)</span>}
                          </td>
                          <td>{v.sent}</td>
                          <td>{v.replied}</td>
                          <td className="mono">{v.replyRate.toFixed(1)}%</td>
                          <td style={{ fontSize: 11.5 }}>
                            <span className={`pill ${verdictPill(v.verdict)}`}>
                              {v.verdict.replace(/_/g, ' ')}
                            </span>
                            <div className="muted" style={{ marginTop: 3 }}>
                              {v.explanation}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Section({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  if (!items.length) return null;
  const color = tone === 'good' ? 'var(--good)' : tone === 'crit' ? 'var(--crit)' : 'var(--accent)';
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  color = 'var(--ink)',
}: {
  label: string;
  value: number;
  sub?: string;
  color?: string;
}) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '9px 11px', background: 'var(--panel-2)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color, marginTop: 2 }}>
        {value.toLocaleString()}
        {sub && <small style={{ fontSize: '0.62em', color: 'var(--muted)', marginLeft: 5 }}>{sub}</small>}
      </div>
    </div>
  );
}

function verdictPill(verdict: string): string {
  return (
    { winning: 'good', losing: 'crit', control: 'neutral', no_difference: 'fu', insufficient_data: 'neutral' }[
      verdict
    ] ?? 'neutral'
  );
}
