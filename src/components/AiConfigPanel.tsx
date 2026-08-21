'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface ModelConfig {
  operation: string;
  model: string;
  maxTokens: number;
  temperature: number;
  isEnabled: boolean;
}

interface AvailableModel {
  id: string;
  label: string;
  tier: string;
  inputPerMillion: number;
  outputPerMillion: number;
  description: string;
}

interface Budget {
  spent: number;
  warnAt: number;
  stopAt: number;
  remaining: number;
  percentUsed: number;
  isWarning: boolean;
  isExceeded: boolean;
  billingPeriod: string;
  callCount: number;
}

const OPERATIONS: { id: string; label: string; description: string; typicalTokens: number }[] = [
  {
    id: 'research',
    label: 'Research',
    description: 'Company summary, pain points, and value proposition. Cached per company.',
    typicalTokens: 2000,
  },
  {
    id: 'email_generation',
    label: 'Email generation',
    description: 'The initial personalized email. Quality matters most here.',
    typicalTokens: 2500,
  },
  {
    id: 'follow_up_generation',
    label: 'Follow-up draft',
    description: 'Shorter message with a new angle, in the same thread.',
    typicalTokens: 1800,
  },
  {
    id: 'reply_classification',
    label: 'Reply classification',
    description: 'Routes an incoming reply. Never writes a response.',
    typicalTokens: 1200,
  },
];

/**
 * The AI control surface.
 *
 * Everything here writes to the database, and the config cache is invalidated
 * on save — so a model change takes effect on the very next call with no
 * deploy, no restart, and no file edit.
 */
export function AiConfigPanel({
  models,
  availableModels,
  budget,
  byOperation,
  dailySpend,
  canEdit,
}: {
  models: ModelConfig[];
  availableModels: AvailableModel[];
  budget: Budget;
  byOperation: { operation: string; costUsd: number; callCount: number; tokens: number }[];
  dailySpend: { date: string; costUsd: number; callCount: number }[];
  canEdit: boolean;
}) {
  const router = useRouter();

  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(models.map((m) => [m.operation, m.model])),
  );
  const [warnAt, setWarnAt] = useState(budget.warnAt);
  const [stopAt, setStopAt] = useState(budget.stopAt);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  const modelFor = (operation: string) =>
    draft[operation] ?? models.find((m) => m.operation === operation)?.model ?? 'claude-haiku-4-5';

  const isDirty =
    models.some((m) => draft[m.operation] !== m.model) ||
    warnAt !== budget.warnAt ||
    stopAt !== budget.stopAt;

  /** Indicative per-call cost so a model change shows its price consequence. */
  function estimateCost(modelId: string, tokens: number): number {
    const model = availableModels.find((m) => m.id === modelId);
    if (!model) return 0;
    // Assume a 70/30 input/output split, which matches these prompt shapes.
    return (
      (tokens * 0.7 * model.inputPerMillion) / 1_000_000 +
      (tokens * 0.3 * model.outputPerMillion) / 1_000_000
    );
  }

  async function save() {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/ai', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          models: OPERATIONS.map((op) => ({ operation: op.id, model: modelFor(op.id) })),
          budgetWarn: warnAt,
          budgetStop: stopAt,
        }),
      });
      const json = await response.json();

      if (json.ok) {
        setMessage({ text: json.data.message, kind: 'good' });
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

  const maxDaily = Math.max(...dailySpend.map((d) => d.costUsd), 0.01);

  return (
    <>
      {message && (
        <div className={`banner ${message.kind}`}>
          <span>{message.text}</span>
        </div>
      )}

      {budget.isExceeded && (
        <div className="banner crit">
          ⛔{' '}
          <span>
            <b>Budget exhausted</b> — AI operations are paused. Raise the stop threshold below to
            resume immediately.
          </span>
        </div>
      )}

      <div className="grid2">
        {/* --- Model per operation --------------------------------------- */}
        <div className="card">
          <div className="ch">
            <h3>Model per operation</h3>
            <span className="hint">applies to the next call</span>
          </div>

          {OPERATIONS.map((operation) => {
            const selected = modelFor(operation.id);
            const cost = estimateCost(selected, operation.typicalTokens);
            const current = models.find((m) => m.operation === operation.id);
            const changed = current && current.model !== selected;

            return (
              <div
                key={operation.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 10,
                  alignItems: 'center',
                  padding: '11px 4px',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {operation.label}
                    {changed && (
                      <span className="pill rev" style={{ marginLeft: 7 }}>
                        Changed
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{operation.description}</div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <select
                    value={selected}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setDraft((current) => ({ ...current, [operation.id]: e.target.value }))
                    }
                    style={{ width: 'auto', minWidth: 150, fontSize: 12, padding: '5px 8px' }}
                    aria-label={`Model for ${operation.label}`}
                  >
                    {availableModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                    ~${cost.toFixed(4)}/call
                  </span>
                </div>
              </div>
            );
          })}

          <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--muted)' }}>
            {availableModels.map((model) => (
              <div key={model.id} style={{ marginBottom: 4 }}>
                <b style={{ color: 'var(--ink)' }}>{model.label}</b> — {model.description}
              </div>
            ))}
          </div>
        </div>

        {/* --- Budget + prompts ------------------------------------------ */}
        <div className="card">
          <div className="ch">
            <h3>Spend limits</h3>
            <span className="hint">{budget.billingPeriod}</span>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                ${budget.spent.toFixed(2)}
                <small style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 600 }}>
                  {' '}
                  spent this month
                </small>
              </div>
              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                {budget.callCount} calls
              </span>
            </div>
            <div className="track">
              <div
                className={`fill ${budget.isExceeded ? 'crit' : budget.isWarning ? 'warn' : ''}`}
                style={{ width: `${Math.min(100, budget.percentUsed)}%` }}
              />
              <div className="thresh" style={{ left: `${(budget.warnAt / budget.stopAt) * 100}%` }} />
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label htmlFor="warnAt">Warn at (USD/month)</label>
            <input
              id="warnAt"
              type="number"
              min={1}
              step={1}
              value={warnAt}
              disabled={!canEdit}
              onChange={(e) => setWarnAt(Number(e.target.value))}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              A notification is raised. Work continues.
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="stopAt">Hard stop at (USD/month)</label>
            <input
              id="stopAt"
              type="number"
              min={1}
              step={1}
              value={stopAt}
              disabled={!canEdit}
              onChange={(e) => setStopAt(Number(e.target.value))}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Every AI call is refused past this. Sending and tracking keep working.
            </div>
          </div>

          {warnAt >= stopAt && (
            <div className="banner crit" style={{ marginBottom: 12 }}>
              <span>The warning threshold must be lower than the stop threshold.</span>
            </div>
          )}

          <div className="seclabel" style={{ marginTop: 18 }}>
            System prompts
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            Edit the instructions behind each operation. Every save creates a new version, so a bad
            edit is one click to revert.
          </div>
          <Link href="/settings/prompts" className="ctrl sm">
            Open prompt editor →
          </Link>
        </div>
      </div>

      {canEdit && (
        <div className="row">
          <button
            className="ctrl primary"
            onClick={() => void save()}
            disabled={saving || !isDirty || warnAt >= stopAt}
          >
            {saving ? <span className="spin" /> : 'Save configuration'}
          </button>
          {isDirty && <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span>}
        </div>
      )}

      {/* --- Usage ------------------------------------------------------- */}
      <div className="grid2" id="usage">
        <div className="card">
          <div className="ch">
            <h3>Daily spend</h3>
            <span className="hint">last 30 days</span>
          </div>
          {dailySpend.length === 0 ? (
            <div className="empty">No AI spend recorded yet.</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120 }}>
              {dailySpend.map((day) => (
                <div
                  key={day.date}
                  title={`${day.date}: $${day.costUsd.toFixed(4)} (${day.callCount} calls)`}
                  style={{
                    flex: 1,
                    height: `${Math.max(2, (day.costUsd / maxDaily) * 100)}%`,
                    background: 'var(--accent)',
                    borderRadius: '3px 3px 0 0',
                    minWidth: 3,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="ch">
            <h3>Spend by operation</h3>
            <span className="hint">{budget.billingPeriod}</span>
          </div>
          {byOperation.length === 0 ? (
            <div className="empty">No AI calls yet this month.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Operation</th>
                    <th>Calls</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {byOperation.map((row) => (
                    <tr key={row.operation}>
                      <td>{OPERATIONS.find((o) => o.id === row.operation)?.label ?? row.operation}</td>
                      <td className="mono">{row.callCount}</td>
                      <td className="mono">{row.tokens.toLocaleString()}</td>
                      <td className="mono">${row.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
