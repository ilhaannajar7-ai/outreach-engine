'use client';

/**
 * Per-user theme customizer.
 *
 * Every control applies to the live document immediately (instant preview);
 * "Save" persists to the account so it follows the user to every page and every
 * device. Nothing here is destructive — "Reset" returns to the app defaults.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  type ThemePreferences,
  type FontKey,
  DEFAULT_THEME,
  FONT_LABELS,
  ACCENT_PRESETS,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  RADIUS_MIN,
  RADIUS_MAX,
  applyThemeToDocument,
} from '@/lib/theme';

const HEX = /^#[0-9a-fA-F]{6}$/;

export function ThemeCustomizer({ initial }: { initial: ThemePreferences }) {
  const router = useRouter();
  const [t, setT] = useState<ThemePreferences>(initial);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  // Apply live on every change so the whole app previews instantly.
  useEffect(() => {
    applyThemeToDocument(t);
  }, [t]);

  function set<K extends keyof ThemePreferences>(key: K, value: ThemePreferences[K]) {
    setT((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setMessage(null);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/account/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t),
      });
      const json = await res.json();
      if (json.ok) {
        setDirty(false);
        setMessage({ text: 'Theme saved. It will follow you across the app.', kind: 'good' });
        router.refresh(); // re-render the server layout with the saved theme
      } else {
        setMessage({ text: json.error ?? 'Could not save.', kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setT(DEFAULT_THEME);
    setDirty(true);
    setMessage(null);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, alignItems: 'start' }}>
      {/* ---- Controls -------------------------------------------------- */}
      <div className="card">
        <div className="ch">
          <h3>Appearance</h3>
          <span className="hint">{dirty ? 'unsaved changes' : 'saved'}</span>
        </div>

        {message && (
          <div className={`banner ${message.kind}`} style={{ marginBottom: 14 }}>
            <span>{message.text}</span>
          </div>
        )}

        <Field label="Mode" hint="Light, dark, or match your device.">
          <Segmented
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            value={t.mode}
            onChange={(v) => set('mode', v as ThemePreferences['mode'])}
          />
        </Field>

        <Field label="Accent colour" hint="Buttons, links, highlights.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                title={preset.name}
                onClick={() => set('accent', preset.value)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: preset.value,
                  border:
                    t.accent.toLowerCase() === preset.value.toLowerCase()
                      ? '2px solid var(--ink)'
                      : '2px solid transparent',
                  boxShadow: '0 0 0 1px var(--line)',
                  cursor: 'pointer',
                }}
              />
            ))}
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                marginLeft: 4,
                fontSize: 12,
                color: 'var(--muted)',
              }}
            >
              <input
                type="color"
                value={HEX.test(t.accent) ? t.accent : '#0c6e63'}
                onChange={(e) => set('accent', e.target.value)}
                style={{ width: 30, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 8, background: 'none', cursor: 'pointer' }}
                aria-label="Custom accent colour"
              />
              Custom
            </label>
          </div>
        </Field>

        <Field label="Font" hint="The typeface used across the app.">
          <select
            value={t.fontFamily}
            onChange={(e) => set('fontFamily', e.target.value as FontKey)}
            style={selectStyle}
          >
            {(Object.keys(FONT_LABELS) as FontKey[]).map((key) => (
              <option key={key} value={key}>
                {FONT_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>

        <Field label={`Text size — ${Math.round(t.fontScale * 100)}%`} hint="Scales the interface text.">
          <input
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={0.05}
            value={t.fontScale}
            onChange={(e) => set('fontScale', Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </Field>

        <Field label={`Corner radius — ${t.radius}px`} hint="Sharp to rounded.">
          <input
            type="range"
            min={RADIUS_MIN}
            max={RADIUS_MAX}
            step={1}
            value={t.radius}
            onChange={(e) => set('radius', Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </Field>

        <Field label="Density" hint="Spacing between elements.">
          <Segmented
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
            value={t.density}
            onChange={(v) => set('density', v as ThemePreferences['density'])}
          />
        </Field>

        <Field label="Navigation placement" hint="Which side the sidebar sits on.">
          <Segmented
            options={[
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ]}
            value={t.sidebar}
            onChange={(v) => set('sidebar', v as ThemePreferences['sidebar'])}
          />
        </Field>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="ctrl primary" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? <span className="spin" /> : 'Save theme'}
          </button>
          <button className="ctrl ghost" onClick={reset} disabled={saving}>
            Reset to defaults
          </button>
        </div>
      </div>

      {/* ---- Live preview --------------------------------------------- */}
      <div className="card" style={{ position: 'sticky', top: 16 }}>
        <div className="ch">
          <h3>Preview</h3>
          <span className="hint">live</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: '1.15rem', fontWeight: 800, letterSpacing: '-0.02em' }}>
            Aa Bb Cc — 123
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            The quick brown fox jumps over the lazy dog while the outreach engine hums along.
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <button className="ctrl primary sm">Primary</button>
            <button className="ctrl sm">Secondary</button>
            <span className="pill good">Active</span>
            <span className="pill fu">Warming</span>
          </div>

          <div
            style={{
              marginTop: 6,
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              background: 'var(--panel-2)',
              padding: 12,
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Reputation
            </div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--accent)' }}>97%</div>
            <div className="track" style={{ marginTop: 8 }}>
              <div className="fill" style={{ width: '97%' }} />
            </div>
          </div>

          <a className="act" style={{ color: 'var(--accent)', fontSize: 12.5 }}>
            An accent link →
          </a>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>{hint}</div>}
      {children}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        background: 'var(--panel-2)',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              padding: '7px 14px',
              fontSize: 12.5,
              fontWeight: 600,
              border: 'none',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--muted)',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 11px',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--panel)',
  color: 'var(--ink)',
  fontSize: 13,
};
