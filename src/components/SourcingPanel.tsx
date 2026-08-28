'use client';

/**
 * Auto-sourcing configuration (Apollo).
 *
 * The two switches here decide how far a newly found company travels on its
 * own: find companies, and draft the email once research is strong enough.
 * Approval is deliberately absent — sending always waits for a human, and that
 * is not configurable.
 */

import { useCallback, useEffect, useState } from 'react';

interface SourcingConfig {
  provider: string;
  providerConfigured: boolean;
  autoSourcingEnabled: boolean;
  autoGenerateAfterResearch: boolean;
  jobTitles: string[];
  locations: string[];
  employeeRanges: string[];
  dailyLimit: number;
  pageCursor: number;
}

export function SourcingPanel({ canEdit }: { canEdit: boolean }) {
  const [cfg, setCfg] = useState<SourcingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/sourcing', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok) setCfg(json.data as SourcingConfig);
      else setMessage({ text: json.error ?? 'Could not load settings.', kind: 'crit' });
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>, successText: string) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings/sourcing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.ok) {
        setMessage({ text: json.data.message ?? successText, kind: 'good' });
        await load();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const res = await fetch('/api/settings/sourcing/test', { method: 'POST' });
      const json = await res.json();
      if (json.ok) setTest({ ok: json.data.ok, message: json.data.message });
      else setTest({ ok: false, message: json.error });
    } catch {
      setTest({ ok: false, message: 'Could not reach the server.' });
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <div className="card"><div className="empty">Loading…</div></div>;
  if (!cfg) {
    return (
      <div className="card">
        <div className="banner crit">
          <span>{message?.text ?? 'Could not load sourcing settings.'}</span>
        </div>
      </div>
    );
  }

  const disabled = !canEdit || saving || !cfg.providerConfigured;

  return (
    <>
      {message && (
        <div className={`banner ${message.kind}`}>
          <span>{message.text}</span>
        </div>
      )}

      {!cfg.providerConfigured && (
        <div className="banner">
          ℹ️{' '}
          <span>
            <b>Apollo is not connected yet.</b> Auto-sourcing is inert until the server has{' '}
            <span className="mono">SOURCING_PROVIDER=apollo</span> and{' '}
            <span className="mono">APOLLO_API_KEY</span> set. Buy an Apollo plan with API access,
            add those two values, and this page switches on. Apollo&apos;s search API requires a
            <b> paid</b> plan — a free key returns 403.
          </span>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>Automatic lead sourcing</h3>
          <span className="hint">
            provider: {cfg.provider}
            {cfg.providerConfigured ? '' : ' (not configured)'}
          </span>
          <button className="ctrl sm" onClick={() => void runTest()} disabled={testing || !canEdit}>
            {testing ? <span className="spin" /> : 'Test connection'}
          </button>
        </div>

        {test && (
          <div className={`banner ${test.ok ? 'good' : 'crit'}`} style={{ marginBottom: 12 }}>
            <span>{test.message}</span>
          </div>
        )}

        <Toggle
          label="Find new companies automatically"
          hint="Runs once a day at 07:00 and adds companies that are hiring for your target roles. Companies you already have are skipped before any credit is spent."
          checked={cfg.autoSourcingEnabled}
          disabled={disabled}
          onChange={(v) => patch({ autoSourcingEnabled: v }, 'Saved.')}
        />

        <Toggle
          label="Draft emails automatically after research"
          hint="When research finds a strong, company-specific hook, the draft is written and placed in the approval queue. Weak research is flagged for you instead — it is never auto-drafted."
          checked={cfg.autoGenerateAfterResearch}
          disabled={!canEdit || saving}
          onChange={(v) => patch({ autoGenerateAfterResearch: v }, 'Saved.')}
        />

        <div style={{ borderTop: '1px solid var(--line)', margin: '14px 0' }} />

        <Field label="Target job titles" hint="Companies hiring for these roles are what the search looks for.">
          <TagList
            values={cfg.jobTitles}
            disabled={disabled}
            onChange={(v) => patch({ jobTitles: v }, 'Saved.')}
            placeholder="e.g. Bookkeeper"
          />
        </Field>

        <Field label="Locations" hint="Leave empty for no location filter.">
          <TagList
            values={cfg.locations}
            disabled={disabled}
            onChange={(v) => patch({ locations: v }, 'Saved.')}
            placeholder="e.g. United States"
          />
        </Field>

        <Field label="Company size ranges" hint='Employee counts as "min,max" pairs.'>
          <TagList
            values={cfg.employeeRanges}
            disabled={disabled}
            onChange={(v) => patch({ employeeRanges: v }, 'Saved.')}
            placeholder="e.g. 11,50"
          />
        </Field>

        <Field
          label={`Companies per run — ${cfg.dailyLimit}`}
          hint="The cap for one daily run. Each company costs enrichment credits, so this is your spend control."
        >
          <input
            type="range"
            min={1}
            max={100}
            value={cfg.dailyLimit}
            disabled={disabled}
            onChange={(e) => setCfg({ ...cfg, dailyLimit: Number(e.target.value) })}
            onMouseUp={(e) => patch({ dailyLimit: Number((e.target as HTMLInputElement).value) }, 'Saved.')}
            style={{ width: '100%' }}
          />
        </Field>

        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          <button
            className="ctrl primary"
            disabled={disabled}
            onClick={() => patch({ runNow: true }, 'Sourcing run queued.')}
            title="Queue one run now instead of waiting for 07:00"
          >
            {saving ? <span className="spin" /> : 'Run sourcing now'}
          </button>
          <button
            className="ctrl"
            disabled={disabled}
            onClick={() => patch({ resetPageCursor: true }, 'Paging reset.')}
            title="Start reading Apollo results from page 1 again"
          >
            Reset paging (page {cfg.pageCursor})
          </button>
        </div>

        <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
          Each run advances a page cursor so the next day reads new results rather than the same
          first page. Quota errors stop the run and notify you instead of retrying and burning
          credits. Nothing sends automatically — every email still waits in the approval queue.
        </div>
      </div>
    </>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '10px 0',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 'auto', marginTop: 3 }}
      />
      <span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 7 }}>{hint}</div>}
      {children}
    </div>
  );
}

function TagList({
  values,
  disabled,
  onChange,
  placeholder,
}: {
  values: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');

  function add() {
    const value = draft.trim();
    if (!value || values.includes(value)) return;
    onChange([...values, value]);
    setDraft('');
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 7 }}>
        {values.length === 0 && (
          <span className="muted" style={{ fontSize: 11.5 }}>
            None set.
          </span>
        )}
        {values.map((value) => (
          <span
            key={value}
            className="pill neutral"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {value}
            {!disabled && (
              <button
                onClick={() => onChange(values.filter((v) => v !== value))}
                aria-label={`Remove ${value}`}
                style={{ border: 'none', background: 'none', color: 'inherit', padding: 0, lineHeight: 1 }}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button className="ctrl sm" onClick={add} disabled={!draft.trim()}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}
