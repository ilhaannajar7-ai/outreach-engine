'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Inbox {
  id: string;
  emailAddress: string;
  displayName: string;
  status: string;
  sentToday: number;
  dailySendLimit: number;
  reputationScore: number;
  warmupCompleted: boolean;
}

interface Domain {
  id: string;
  domain: string;
  status: string;
  spfStatus: string;
  dkimStatus: string;
  dmarcStatus: string;
  dailySendLimit: number;
  maxDailySendLimit: number;
  warmupCompleted: boolean;
  warmupProgress: number;
  warmupWeek: number;
  warmupTotalWeeks: number;
  sentToday: number;
  inboxCount: number;
  inboxes: Inbox[];
}

/**
 * Sending infrastructure panel.
 *
 * Adding a domain, adding an inbox, and re-checking DNS all happen here — the
 * dashboard is the only surface needed to scale sending from one domain to five.
 */
export function DomainPanel({ domains }: { domains: Domain[] }) {
  const router = useRouter();
  const [showAddDomain, setShowAddDomain] = useState(false);
  const [showAddInbox, setShowAddInbox] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  async function recheckDns(domainId: string) {
    setBusy(domainId);
    setMessage(null);
    try {
      const response = await fetch(`/api/domains/${domainId}/verify-dns`, { method: 'POST' });
      const json = await response.json();
      setMessage({
        text: json.ok ? json.data.message : json.error,
        kind: json.ok ? 'good' : 'crit',
      });
      if (json.ok) router.refresh();
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="ch">
        <h3>Sending infrastructure</h3>
        <span className="hint">
          {domains.length} domain{domains.length === 1 ? '' : 's'} ·{' '}
          {domains.reduce((sum, d) => sum + d.inboxCount, 0)} inboxes
        </span>
        <button className="ctrl sm" onClick={() => setShowAddDomain(true)}>
          + Add domain
        </button>
      </div>

      {message && (
        <div className={`banner ${message.kind}`} style={{ marginBottom: 12 }}>
          <span>{message.text}</span>
        </div>
      )}

      {domains.length === 0 ? (
        <div className="empty">
          No sending domains yet. Add one to start — you&apos;ll need SPF, DKIM, and DMARC records
          in DNS before it can send.
        </div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Domain</th>
                <th>Inboxes</th>
                <th>Warm-up</th>
                <th>SPF · DKIM · DMARC</th>
                <th>Daily cap</th>
                <th>Sent today</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {domains.map((domain) => (
                <tr key={domain.id}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {domain.domain}
                  </td>
                  <td>{domain.inboxCount}</td>
                  <td>
                    {domain.warmupCompleted ? (
                      <span className="pill good">Complete</span>
                    ) : domain.warmupWeek > 0 ? (
                      <>
                        <span className="warmwrap">
                          <span className="warmfill" style={{ width: `${domain.warmupProgress}%` }} />
                        </span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 6 }}>
                          wk {domain.warmupWeek}/{domain.warmupTotalWeeks}
                        </span>
                      </>
                    ) : (
                      <span className="muted" style={{ fontSize: 11 }}>
                        not started
                      </span>
                    )}
                  </td>
                  <td>
                    <AuthBadge label="SPF" status={domain.spfStatus} />
                    <AuthBadge label="DKIM" status={domain.dkimStatus} />
                    <AuthBadge label="DMARC" status={domain.dmarcStatus} />
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {domain.dailySendLimit}/day
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {domain.sentToday}
                  </td>
                  <td>
                    <span className={`pill ${domainPill(domain.status)}`}>{formatLabel(domain.status)}</span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="ctrl sm"
                      onClick={() => void recheckDns(domain.id)}
                      disabled={busy === domain.id}
                    >
                      {busy === domain.id ? <span className="spin" /> : 'Re-check DNS'}
                    </button>{' '}
                    <button className="ctrl sm" onClick={() => setShowAddInbox(domain.id)}>
                      + Inbox
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {domains.some((d) => d.inboxes.length > 0) && (
        <div style={{ marginTop: 14 }}>
          <div className="seclabel">
            Inboxes ({domains.reduce((sum, d) => sum + d.inboxCount, 0)} total)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
            {domains.flatMap((d) => d.inboxes).map((inbox) => (
              <div
                key={inbox.id}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 9,
                  padding: '10px 12px',
                  background: 'var(--panel-2)',
                }}
              >
                <div className="mono" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 5 }}>
                  {inbox.emailAddress}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--muted)', flexWrap: 'wrap' }}>
                  <span>
                    Rep:{' '}
                    <b style={{ color: reputationColor(inbox.reputationScore) }}>{inbox.reputationScore}</b>
                  </span>
                  <span>·</span>
                  <span>
                    {inbox.sentToday}/{inbox.dailySendLimit} today
                  </span>
                  <span>·</span>
                  <span className={`pill ${inboxPill(inbox.status)}`} style={{ padding: '1px 7px' }}>
                    {formatLabel(inbox.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showAddDomain && <AddDomainModal onClose={() => setShowAddDomain(false)} onDone={() => router.refresh()} />}
      {showAddInbox && (
        <AddInboxModal
          domainId={showAddInbox}
          domain={domains.find((d) => d.id === showAddInbox)?.domain ?? ''}
          onClose={() => setShowAddInbox(null)}
          onDone={() => router.refresh()}
        />
      )}
    </div>
  );
}

function AddDomainModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [domain, setDomain] = useState('');
  const [maxDaily, setMaxDaily] = useState(200);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; dns?: Record<string, { status: string; message: string }> } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);

    try {
      const response = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim(), maxDailySendLimit: maxDaily, startWarmup: true }),
      });
      const json = await response.json();

      if (json.ok) {
        setResult({ ok: true, message: json.data.nextStep, dns: json.data.dns });
        onDone();
      } else {
        setResult({ ok: false, message: json.error });
      }
    } catch {
      setResult({ ok: false, message: 'Could not reach the server.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add a sending domain</h2>

        {result?.ok ? (
          <>
            <div className="banner good" style={{ marginBottom: 14 }}>
              <span>{result.message}</span>
            </div>
            {result.dns && (
              <div className="stack" style={{ marginBottom: 14 }}>
                {Object.entries(result.dns)
                  .filter(([key]) => key !== 'allPassing')
                  .map(([key, check]) => (
                    <div key={key} style={{ fontSize: 12 }}>
                      <AuthBadge label={key.toUpperCase()} status={check.status} />{' '}
                      <span className="muted">{check.message}</span>
                    </div>
                  ))}
              </div>
            )}
            <button className="ctrl primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="domain">Domain</label>
              <input
                id="domain"
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="outreach.yourcompany.com"
                required
                autoFocus
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
                Use a variation of your real brand. Prospects who look it up should recognise your
                company.
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label htmlFor="maxDaily">Maximum daily sends (after warm-up)</label>
              <input
                id="maxDaily"
                type="number"
                min={1}
                max={1000}
                value={maxDaily}
                onChange={(e) => setMaxDaily(Number(e.target.value))}
              />
            </div>

            {result && !result.ok && (
              <div className="banner crit" style={{ marginBottom: 14 }}>
                <span>{result.message}</span>
              </div>
            )}

            <div className="row">
              <button type="submit" className="ctrl primary" disabled={submitting || !domain.trim()}>
                {submitting ? <span className="spin" /> : 'Add domain & check DNS'}
              </button>
              <button type="button" className="ctrl ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function AddInboxModal({
  domainId,
  domain,
  onClose,
  onDone,
}: {
  domainId: string;
  domain: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [localPart, setLocalPart] = useState('outreach');
  const [displayName, setDisplayName] = useState('');
  const [maxDaily, setMaxDaily] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/inboxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domainId,
          localPart: localPart.trim(),
          displayName: displayName.trim(),
          maxDailySendLimit: maxDaily,
          startWarmup: true,
        }),
      });
      const json = await response.json();

      if (json.ok) {
        setSuccess(json.data.message);
        onDone();
      } else {
        setError(json.error);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add an inbox to {domain}</h2>

        {success ? (
          <>
            <div className="banner good" style={{ marginBottom: 14 }}>
              <span>{success}</span>
            </div>
            <button className="ctrl primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="localPart">Email address</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                <input
                  id="localPart"
                  type="text"
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value)}
                  required
                  autoFocus
                  style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                />
                <span
                  className="mono"
                  style={{
                    padding: '8px 11px',
                    border: '1px solid var(--line)',
                    borderLeft: 'none',
                    borderTopRightRadius: 'var(--radius-sm)',
                    borderBottomRightRadius: 'var(--radius-sm)',
                    background: 'var(--panel-2)',
                    color: 'var(--muted)',
                    fontSize: 12.5,
                    whiteSpace: 'nowrap',
                  }}
                >
                  @{domain}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
                This mailbox must already exist with your email host before it can send.
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label htmlFor="displayName">Display name</label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your Name"
                required
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label htmlFor="inboxMax">Maximum daily sends (after warm-up)</label>
              <input
                id="inboxMax"
                type="number"
                min={1}
                max={500}
                value={maxDaily}
                onChange={(e) => setMaxDaily(Number(e.target.value))}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
                Starts at 10/day and ramps weekly. The ramp is what protects the domain — it cannot
                be skipped.
              </div>
            </div>

            {error && (
              <div className="banner crit" style={{ marginBottom: 14 }}>
                <span>{error}</span>
              </div>
            )}

            <div className="row">
              <button
                type="submit"
                className="ctrl primary"
                disabled={submitting || !localPart.trim() || !displayName.trim()}
              >
                {submitting ? <span className="spin" /> : 'Add inbox'}
              </button>
              <button type="button" className="ctrl ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function AuthBadge({ label, status }: { label: string; status: string }) {
  const kind = status === 'pass' ? 'ok' : status === 'missing' ? 'err' : status === 'fail' ? 'err' : 'warn';
  return <span className={`authbadge ${kind}`}>{label}</span>;
}

function domainPill(status: string): string {
  return { active: 'good', warming: 'fu', pending_dns: 'neutral', paused: 'crit', suspended: 'crit' }[status] ?? 'neutral';
}

function inboxPill(status: string): string {
  return { active: 'good', warming: 'fu', pending_setup: 'neutral', paused: 'crit', blocked: 'crit' }[status] ?? 'neutral';
}

function reputationColor(score: number): string {
  if (score >= 75) return 'var(--good)';
  if (score >= 50) return 'var(--warn)';
  return 'var(--crit)';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
