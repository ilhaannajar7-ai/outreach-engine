'use client';

/**
 * Live sending & engagement, read straight from Smartlead.
 *
 * This is the provider's own record of what actually left the building and what
 * recipients did with it — deliberately not our mirror of it. The 10-minute sync
 * copies this into our tables for the funnel and reports; showing the source
 * here means a disagreement between the two is visible rather than hidden.
 */

import { useCallback, useEffect, useState } from 'react';

interface Send {
  toEmail: string;
  subject: string;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  repliedAt: string | null;
  openCount: number;
  clickCount: number;
  bounced: boolean;
  unsubscribed: boolean;
  sequenceNumber: number;
}

interface Activity {
  configured: boolean;
  reason?: string;
  campaignId: string | null;
  campaignStatus: string | null;
  fetchedAt: string;
  totals: {
    sent: number;
    opened: number;
    clicked: number;
    replied: number;
    bounced: number;
    unsubscribed: number;
    openRate: number;
    replyRate: number;
    bounceRate: number;
  };
  recent: Send[];
}

const REFRESH_MS = 60_000;

export function SendingActivityPanel() {
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const res = await fetch(`/api/smartlead/activity${force ? '?refresh=1' : ''}`, {
        cache: 'no-store',
      });
      const json = await res.json();
      if (json.ok) {
        setData(json.data as Activity);
        setError(null);
      } else {
        setError(json.error ?? 'Could not load sending activity.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const t = data?.totals;

  return (
    <div className="card">
      <div className="ch">
        <h3>Sending &amp; engagement</h3>
        <span className="hint">
          {loading ? 'loading…' : data ? `live from Smartlead · ${timeAgo(data.fetchedAt)}` : 'live'}
        </span>
        <button className="ctrl sm" onClick={() => void load(true)} disabled={refreshing || loading}>
          {refreshing ? <span className="spin" /> : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="banner crit" style={{ marginBottom: 12 }}>
          <span>{error}</span>
        </div>
      )}

      {loading && !data && <div className="empty">Loading sending activity…</div>}

      {data && !data.configured && (
        <div className="empty">{data.reason ?? 'Smartlead sending is not configured yet.'}</div>
      )}

      {data?.configured && data.reason && (
        <div className="banner" style={{ marginBottom: 12 }}>
          <span>{data.reason}</span>
        </div>
      )}

      {data?.configured && t && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
              gap: 10,
              marginBottom: 14,
            }}
          >
            <Stat label="Sent" value={t.sent} />
            <Stat
              label="Opened"
              value={t.opened}
              sub={`${t.openRate.toFixed(0)}%`}
              color="var(--accent-2)"
            />
            <Stat label="Clicked" value={t.clicked} />
            <Stat
              label="Replied"
              value={t.replied}
              sub={`${t.replyRate.toFixed(0)}%`}
              color="var(--good)"
            />
            <Stat
              label="Bounced"
              value={t.bounced}
              sub={`${t.bounceRate.toFixed(1)}%`}
              color={t.bounceRate > 3 ? 'var(--crit)' : 'var(--muted)'}
            />
            <Stat label="Unsubscribed" value={t.unsubscribed} />
          </div>

          {t.bounceRate > 3 && t.sent >= 20 && (
            <div className="banner crit" style={{ marginBottom: 12 }}>
              ⛔{' '}
              <span>
                <b>Bounce rate is {t.bounceRate.toFixed(1)}%</b> — above the 3% danger line. Pause
                sending and check list quality before this damages the domain.
              </span>
            </div>
          )}

          {data.campaignStatus && data.campaignStatus !== 'ACTIVE' && (
            <div className="banner" style={{ marginBottom: 12 }}>
              ⚠️{' '}
              <span>
                Relay campaign status is <b>{data.campaignStatus}</b>. It is re-activated
                automatically on the next send or within 10 minutes.
              </span>
            </div>
          )}

          {data.recent.length === 0 ? (
            <div className="empty">
              Nothing sent yet. Approved emails appear here once Smartlead delivers them.
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Subject</th>
                    <th>Step</th>
                    <th>Sent</th>
                    <th>Engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((s, i) => (
                    <tr key={`${s.toEmail}-${s.sentAt ?? i}`}>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {s.toEmail}
                      </td>
                      <td style={{ fontSize: 12, maxWidth: 260 }}>{s.subject}</td>
                      <td>
                        <span className={`pill ${s.sequenceNumber > 1 ? 'fu' : 'new'}`}>
                          {s.sequenceNumber > 1 ? `Follow-up ${s.sequenceNumber - 1}` : 'Initial'}
                        </span>
                      </td>
                      <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                        {s.sentAt ? new Date(s.sentAt).toLocaleString() : '—'}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {s.repliedAt && <span className="pill good">Replied</span>}{' '}
                        {s.openedAt && <span className="pill int">Opened ×{s.openCount}</span>}{' '}
                        {s.clickedAt && <span className="pill rev">Clicked</span>}{' '}
                        {s.bounced && <span className="pill crit">Bounced</span>}{' '}
                        {s.unsubscribed && <span className="pill crit">Unsub</span>}
                        {!s.repliedAt && !s.openedAt && !s.bounced && !s.unsubscribed && (
                          <span className="muted" style={{ fontSize: 11 }}>
                            No activity yet
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
            Open tracking undercounts (many clients block the pixel) and overcounts where a client
            preloads images — judge on replies. Auto-refreshes every minute.
          </div>
        </>
      )}
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
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '9px 11px',
        background: 'var(--panel-2)',
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          color: 'var(--muted)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.3rem',
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          color,
          marginTop: 2,
        }}
      >
        {value.toLocaleString()}
        {sub && (
          <small style={{ fontSize: '0.62em', color: 'var(--muted)', marginLeft: 5, fontWeight: 600 }}>
            {sub}
          </small>
        )}
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}
