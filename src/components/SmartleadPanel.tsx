'use client';

/**
 * Live Smartlead warm-up & deliverability panel.
 *
 * Shows the numbers that actually matter during warm-up — Smartlead's own
 * reputation score, inbox-vs-spam placement, and the daily ramp — pulled live
 * from Smartlead's API and auto-refreshed. This is the real health signal; the
 * app's own per-inbox "reputation" only moves after 20+ real sends.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityChart } from '@/components/charts';

interface WarmupDayStat {
  date: string;
  sent: number;
  replies: number;
  savedFromSpam: number;
}

interface SmartleadAccount {
  emailAddress: string;
  fromName: string | null;
  warmupEnabled: boolean;
  warmupStatus: string | null;
  reputation: number | null;
  smtpConnected: boolean;
  imapConnected: boolean;
  blockedReason: string | null;
  messagePerDay: number | null;
  dailySentCount: number;
  maxWarmupPerDay: number | null;
  totalWarmupSent: number;
  totalWarmupSpam: number;
  warmupInboxCount: number;
  warmupReceived: number;
  spamRate: number | null;
  statsByDate: WarmupDayStat[];
}

interface SmartleadWarmup {
  configured: boolean;
  reason?: string;
  fetchedAt: string;
  accounts: SmartleadAccount[];
}

const REFRESH_MS = 60_000;

export function SmartleadPanel() {
  const [data, setData] = useState<SmartleadWarmup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const res = await fetch(`/api/smartlead/warmup${force ? '?refresh=1' : ''}`, {
        cache: 'no-store',
      });
      const json = await res.json();
      if (json.ok) {
        setData(json.data as SmartleadWarmup);
        setError(null);
      } else {
        setError(json.error ?? 'Could not load Smartlead data.');
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

  return (
    <div className="card">
      <div className="ch">
        <h3>Smartlead warm-up &amp; deliverability</h3>
        <span className="hint">
          {loading
            ? 'loading…'
            : data
              ? `live · updated ${timeAgo(data.fetchedAt)}`
              : 'live'}
        </span>
        <button className="ctrl sm" onClick={() => void load(true)} disabled={refreshing || loading}>
          {refreshing ? <span className="spin" /> : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="banner crit" style={{ marginBottom: 12 }}>
          <span>{error}</span>
        </div>
      )}

      {loading && !data && <div className="empty">Fetching live data from Smartlead…</div>}

      {data && !data.configured && (
        <div className="empty">
          {data.reason ?? 'Smartlead is not connected yet.'} Once a mailbox is connected to
          Smartlead, its real warm-up score and inbox placement appear here.
        </div>
      )}

      {data && data.configured && data.accounts.length === 0 && (
        <div className="empty">No Smartlead mailboxes found for this organization.</div>
      )}

      {data &&
        data.configured &&
        data.accounts.map((acct) => <AccountCard key={acct.emailAddress} acct={acct} />)}

      {data && data.configured && data.accounts.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
          Reputation and placement are computed by Smartlead from its warm-up network — the honest
          signal while you have no real sends yet. Auto-refreshes every minute.
        </div>
      )}
    </div>
  );
}

function AccountCard({ acct }: { acct: SmartleadAccount }) {
  const placementRate =
    acct.totalWarmupSent > 0 ? (acct.warmupInboxCount / acct.totalWarmupSent) * 100 : null;

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '14px 16px',
        background: 'var(--panel-2)',
        marginBottom: 12,
      }}
    >
      {/* Header: mailbox + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
          {acct.emailAddress}
        </span>
        {acct.warmupStatus && (
          <span className={`pill ${statusPill(acct.warmupStatus)}`}>
            {formatLabel(acct.warmupStatus)}
          </span>
        )}
        <ConnBadge label="SMTP" ok={acct.smtpConnected} />
        <ConnBadge label="IMAP" ok={acct.imapConnected} />
        {acct.blockedReason && <span className="pill crit">{acct.blockedReason}</span>}
      </div>

      {acct.blockedReason && (
        <div className="banner crit" style={{ marginBottom: 12 }}>
          <span>Smartlead flagged this mailbox: {acct.blockedReason}</span>
        </div>
      )}

      {/* Stat tiles */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 10,
          marginBottom: 14,
        }}
      >
        <Stat
          label="Warm-up reputation"
          value={acct.reputation != null ? `${acct.reputation}%` : '—'}
          color={reputationColor(acct.reputation)}
          big
        />
        <Stat
          label="Inbox placement"
          value={placementRate != null ? `${placementRate.toFixed(0)}%` : '—'}
          color={placementRate != null && placementRate >= 90 ? 'var(--good)' : 'var(--warn)'}
          sub={`${acct.warmupInboxCount}/${acct.totalWarmupSent} landed in inbox`}
        />
        <Stat
          label="Spam rate"
          value={acct.spamRate != null ? `${acct.spamRate.toFixed(1)}%` : '—'}
          color={acct.spamRate != null && acct.spamRate <= 5 ? 'var(--good)' : 'var(--crit)'}
          sub={`${acct.totalWarmupSpam} of ${acct.totalWarmupSent} warm-up mails`}
        />
        <Stat
          label="Real sends today"
          value={`${acct.dailySentCount}`}
          sub={acct.messagePerDay != null ? `cap ${acct.messagePerDay}/day` : undefined}
        />
        <Stat
          label="Warm-up cap/day"
          value={acct.maxWarmupPerDay != null ? `${acct.maxWarmupPerDay}` : '—'}
          sub={`${acct.warmupReceived} received`}
        />
      </div>

      {/* Daily ramp chart */}
      {acct.statsByDate.length > 1 ? (
        <div>
          <div className="seclabel" style={{ marginBottom: 6 }}>
            Daily warm-up activity
          </div>
          <ActivityChart
            data={acct.statsByDate.map((d) => ({
              date: d.date,
              sent: d.sent,
              replies: d.replies,
            }))}
          />
        </div>
      ) : (
        <div className="empty">No daily history yet.</div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  color = 'var(--ink)',
  big = false,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  big?: boolean;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '9px 11px',
        background: 'var(--panel)',
      }}
    >
      <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: big ? '1.6rem' : '1.15rem',
          fontWeight: 800,
          letterSpacing: '-0.02em',
          fontVariantNumeric: 'tabular-nums',
          color,
          marginTop: 2,
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function ConnBadge({ label, ok }: { label: string; ok: boolean }) {
  return <span className={`authbadge ${ok ? 'ok' : 'err'}`}>{label}</span>;
}

function statusPill(status: string): string {
  const s = status.toUpperCase();
  if (s === 'ACTIVE') return 'good';
  if (s === 'PAUSED') return 'fu';
  if (s === 'BLOCKED' || s === 'ERROR') return 'crit';
  return 'neutral';
}

function reputationColor(score: number | null): string {
  if (score == null) return 'var(--muted)';
  if (score >= 90) return 'var(--good)';
  if (score >= 75) return 'var(--accent-2)';
  if (score >= 50) return 'var(--warn)';
  return 'var(--crit)';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}
