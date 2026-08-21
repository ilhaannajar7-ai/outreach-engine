'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatOperation } from '@/lib/format';

interface PromptRecord {
  operation: string;
  systemPrompt: string;
  userPromptTemplate: string;
  version: number;
  updatedAt: string;
  versions: { version: number; isActive: boolean; updatedAt: string }[];
  defaultSystemPrompt: string;
  defaultUserPromptTemplate: string;
}

const OPERATION_NOTES: Record<string, string> = {
  research:
    'Runs once per company and is cached. Editing this does not re-run existing research — use "Re-run research" on a lead for that.',
  email_generation:
    'The highest-leverage prompt in the system. This is what determines whether an email reads like a person or a template.',
  follow_up_generation:
    'Runs for follow-ups 1 and 2. The follow-up number and the previous messages are passed in as variables.',
  reply_classification:
    'Routes incoming replies. Changing this changes which replies alert you and which suppress a contact — test carefully.',
};

export function PromptEditor({
  prompts,
  canEdit,
}: {
  prompts: PromptRecord[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [active, setActive] = useState(prompts[0]?.operation ?? 'research');
  const [drafts, setDrafts] = useState<Record<string, { system: string; user: string }>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  const current = prompts.find((p) => p.operation === active);
  if (!current) return null;

  const draft = drafts[active];
  const systemPrompt = draft?.system ?? current.systemPrompt;
  const userPrompt = draft?.user ?? current.userPromptTemplate;
  const isDirty =
    systemPrompt !== current.systemPrompt || userPrompt !== current.userPromptTemplate;

  // Show which variables this template can use, pulled from the shipped default.
  const availableVariables = [
    ...new Set(
      (current.defaultUserPromptTemplate.match(/\{\{(\w+)\}\}/g) ?? []).map((v) => v.slice(2, -2)),
    ),
  ];

  function update(field: 'system' | 'user', value: string) {
    setDrafts((prev) => ({
      ...prev,
      [active]: {
        system: field === 'system' ? value : systemPrompt,
        user: field === 'user' ? value : userPrompt,
      },
    }));
  }

  async function save() {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/prompts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: active,
          systemPrompt,
          userPromptTemplate: userPrompt,
        }),
      });
      const json = await response.json();

      if (json.ok) {
        setMessage({ text: json.data.message, kind: 'good' });
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[active];
          return next;
        });
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setSaving(false);
    }
  }

  async function revert(version: number) {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: active, version }),
      });
      const json = await response.json();

      setMessage({ text: json.ok ? json.data.message : json.error, kind: json.ok ? 'good' : 'crit' });
      if (json.ok) {
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[active];
          return next;
        });
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  function resetToDefault() {
    setDrafts((prev) => ({
      ...prev,
      [active]: {
        system: current!.defaultSystemPrompt,
        user: current!.defaultUserPromptTemplate,
      },
    }));
  }

  return (
    <>
      {message && (
        <div className={`banner ${message.kind}`}>
          <span>{message.text}</span>
        </div>
      )}

      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {prompts.map((prompt) => (
          <button
            key={prompt.operation}
            className={`ctrl sm ${active === prompt.operation ? 'primary' : ''}`}
            onClick={() => setActive(prompt.operation)}
          >
            {formatOperation(prompt.operation)}
            {drafts[prompt.operation] && ' •'}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="ch">
          <h3>{formatOperation(active)}</h3>
          <span className="hint">
            {current.version > 0 ? `v${current.version} active` : 'using code default'}
          </span>
        </div>

        <div className="banner" style={{ marginBottom: 14, background: 'var(--panel-2)', borderColor: 'var(--line)' }}>
          <span style={{ color: 'var(--muted)' }}>{OPERATION_NOTES[active]}</span>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label htmlFor="system">System prompt — the model&apos;s role and rules</label>
          <textarea
            id="system"
            value={systemPrompt}
            rows={16}
            disabled={!canEdit}
            onChange={(e) => update('system', e.target.value)}
            className="mono"
            style={{ fontSize: 12, lineHeight: 1.6 }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="user">User prompt template — the per-lead data</label>
          <textarea
            id="user"
            value={userPrompt}
            rows={12}
            disabled={!canEdit}
            onChange={(e) => update('user', e.target.value)}
            className="mono"
            style={{ fontSize: 12, lineHeight: 1.6 }}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 7, lineHeight: 1.7 }}>
            <b>Available variables</b> — anything else renders empty:
            <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {availableVariables.map((variable) => (
                <code
                  key={variable}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    background: 'var(--panel-2)',
                    border: '1px solid var(--line)',
                    borderRadius: 4,
                    padding: '1px 5px',
                  }}
                >
                  {`{{${variable}}}`}
                </code>
              ))}
            </div>
          </div>
        </div>

        {canEdit && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="ctrl primary" onClick={() => void save()} disabled={saving || !isDirty}>
              {saving ? <span className="spin" /> : `Save as v${current.version + 1}`}
            </button>
            <button className="ctrl ghost" onClick={resetToDefault} disabled={saving}>
              Load shipped default
            </button>
            {isDirty && (
              <span className="muted" style={{ fontSize: 12 }}>
                Unsaved changes
              </span>
            )}
          </div>
        )}

        {current.versions.length > 1 && (
          <div style={{ marginTop: 18 }}>
            <div className="seclabel">Version history</div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Saved</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {current.versions.map((version) => (
                    <tr key={version.version}>
                      <td className="mono">v{version.version}</td>
                      <td className="muted">{new Date(version.updatedAt).toLocaleString()}</td>
                      <td>
                        {version.isActive ? (
                          <span className="pill good">Active</span>
                        ) : (
                          <span className="pill neutral">Superseded</span>
                        )}
                      </td>
                      <td>
                        {!version.isActive && canEdit && (
                          <button
                            className="ctrl sm"
                            onClick={() => void revert(version.version)}
                            disabled={saving}
                          >
                            Revert to this
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
