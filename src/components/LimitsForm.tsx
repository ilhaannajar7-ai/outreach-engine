'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatStatus } from '@/lib/format';

interface Inbox {
  id: string;
  emailAddress: string;
  status: string;
  sentToday: number;
  dailySendLimit: number;
  maxDailySendLimit: number;
  warmupCompleted: boolean;
  domain: string;
}

export function LimitsForm({
  initial,
  sendWindow,
  capacity,
  inboxes,
  canEdit,
}: {
  initial: {
    globalDailySendLimit: number;
    requireEmailVerification: boolean;
    autoResearchOnImport: boolean;
  };
  sendWindow: { startHour: number; endHour: number; timezone: string };
  capacity: { remaining: number; globalLimit: number; sentToday: number; inboxCount: number };
  inboxes: Inbox[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  const isDirty =
    form.globalDailySendLimit !== initial.globalDailySendLimit ||
    form.requireEmailVerification !== initial.requireEmailVerification ||
    form.autoResearchOnImport !== initial.autoResearchOnImport;

  // The global cap can be set higher than the inboxes can actually deliver;
  // showing both makes the real ceiling obvious.
  const inboxCapacity = inboxes
    .filter((i) => i.status === 'active' || i.status === 'warming')
    .reduce((sum, i) => sum + i.dailySendLimit, 0);

  async function save() {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/limits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await response.json();

      setMessage({ text: json.ok ? json.data.message : json.error, kind: json.ok ? 'good' : 'crit' });
      if (json.ok) router.refresh();
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {message && (
        <div className={`banner ${message.kind}`}>
          <span>{message.text}</span>
        </div>
      )}

      {form.globalDailySendLimit > inboxCapacity && inboxCapacity > 0 && (
        <div className="banner">
          ⚠️{' '}
          <span>
            Your global cap is <b>{form.globalDailySendLimit}</b> but your inboxes can only deliver{' '}
            <b>{inboxCapacity}</b> today. The lower number wins — add inboxes or wait for warm-up to
            raise the real ceiling.
          </span>
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <div className="l">Sent today</div>
          <div className="v">{capacity.sentToday}</div>
        </div>
        <div className="kpi">
          <div className="l">Remaining</div>
          <div className="v" style={{ color: capacity.remaining === 0 ? 'var(--warn)' : undefined }}>
            {capacity.remaining}
          </div>
        </div>
        <div className="kpi">
          <div className="l">Global cap</div>
          <div className="v">{capacity.globalLimit}</div>
        </div>
        <div className="kpi">
          <div className="l">Active inboxes</div>
          <div className="v">{capacity.inboxCount}</div>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="ch">
            <h3>Sending limits</h3>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="globalLimit">Global daily send limit</label>
            <input
              id="globalLimit"
              type="number"
              min={1}
              max={5000}
              value={form.globalDailySendLimit}
              disabled={!canEdit}
              onChange={(e) =>
                setForm((c) => ({ ...c, globalDailySendLimit: Number(e.target.value) }))
              }
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
              A hard ceiling across every inbox. Per-inbox warm-up caps still apply underneath — this
              cannot override them.
            </div>
          </div>

          <div className="seclabel" style={{ marginTop: 18 }}>
            Send window (set in .env, requires a restart)
          </div>
          <div
            style={{
              padding: '10px 12px',
              background: 'var(--panel-2)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 12.5,
            }}
          >
            <div>
              <b>
                {String(sendWindow.startHour).padStart(2, '0')}:00 –{' '}
                {String(sendWindow.endHour).padStart(2, '0')}:00
              </b>{' '}
              <span className="muted">{sendWindow.timezone}</span>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Weekdays only. Emails approved outside this window are queued for the next weekday
              morning — cold email sent at 3am or on a Sunday reads as automated.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="ch">
            <h3>Safety &amp; cost</h3>
          </div>

          <Toggle
            id="verify"
            label="Only send to verified addresses"
            description="Blocks sending to addresses the enrichment provider could not confirm. Hard bounces damage domain reputation far more than a missed lead costs."
            checked={form.requireEmailVerification}
            disabled={!canEdit}
            onChange={(v) => setForm((c) => ({ ...c, requireEmailVerification: v }))}
          />

          <Toggle
            id="autoResearch"
            label="Research automatically on import"
            description="Queues an AI research call for every new company as soon as a CSV is imported. Convenient, but it spends AI budget without you choosing which leads are worth it."
            checked={form.autoResearchOnImport}
            disabled={!canEdit}
            onChange={(v) => setForm((c) => ({ ...c, autoResearchOnImport: v }))}
            warn
          />

          {canEdit && (
            <div className="row" style={{ marginTop: 18 }}>
              <button className="ctrl primary" onClick={() => void save()} disabled={saving || !isDirty}>
                {saving ? <span className="spin" /> : 'Save limits'}
              </button>
              {isDirty && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Unsaved changes
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="ch">
          <h3>Per-inbox capacity today</h3>
          <span className="hint">
            {inboxCapacity} total across {inboxes.length} inbox{inboxes.length === 1 ? '' : 'es'}
          </span>
        </div>

        {inboxes.length === 0 ? (
          <div className="empty">
            No inboxes configured. Add one from Sending → Domains &amp; inboxes.
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Inbox</th>
                  <th>Status</th>
                  <th>Today</th>
                  <th>Cap</th>
                  <th>Usage</th>
                  <th>Ceiling</th>
                </tr>
              </thead>
              <tbody>
                {inboxes.map((inbox) => {
                  const pct =
                    inbox.dailySendLimit > 0 ? (inbox.sentToday / inbox.dailySendLimit) * 100 : 0;

                  return (
                    <tr key={inbox.id}>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {inbox.emailAddress}
                      </td>
                      <td>
                        <span className={`pill ${inboxPill(inbox.status)}`}>
                          {formatStatus(inbox.status)}
                        </span>
                      </td>
                      <td className="mono">{inbox.sentToday}</td>
                      <td className="mono">{inbox.dailySendLimit}</td>
                      <td style={{ minWidth: 110 }}>
                        <div className="track" style={{ height: 7 }}>
                          <div
                            className={`fill ${pct >= 100 ? 'warn' : ''}`}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                      </td>
                      <td className="mono muted">
                        {inbox.warmupCompleted ? (
                          inbox.maxDailySendLimit
                        ) : (
                          <span title="Still warming up — the cap rises weekly">
                            → {inbox.maxDailySendLimit}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Toggle({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
  warn,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  warn?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 11,
        padding: '11px 0',
        borderBottom: '1px solid var(--line)',
        alignItems: 'flex-start',
      }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 'auto', marginTop: 2, flex: 'none' }}
      />
      <div>
        <label htmlFor={id} style={{ marginBottom: 2, color: 'var(--ink)', fontSize: 12.5 }}>
          {label}
          {warn && checked && (
            <span className="pill fu" style={{ marginLeft: 7 }}>
              spends budget
            </span>
          )}
        </label>
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>{description}</div>
      </div>
    </div>
  );
}

function inboxPill(status: string): string {
  return (
    { active: 'good', warming: 'fu', pending_setup: 'neutral', paused: 'crit', blocked: 'crit' }[
      status
    ] ?? 'neutral'
  );
}
