'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface VariantRow {
  id: string;
  name: string;
  isControl: boolean;
  sent: number;
  replied: number;
  interested: number;
  replyRate: number;
  interestedRate: number;
  verdict: string;
  explanation: string;
  pValue: number | null;
  lift: number | null;
}

interface VariantDetail {
  id: string;
  name: string;
  description: string | null;
  isControl: boolean;
  isActive: boolean;
  weight: number;
  angleInstructions: string | null;
  ctaStyle: string | null;
  targetLength: string | null;
  promotedAt: string | null;
  assigned: number;
  opened: number;
}

interface Readout {
  variants: VariantRow[];
  details: VariantDetail[];
  winnerId: string | null;
  totalSent: number;
  summary: string;
  alpha: number;
  recommendedSampleSize: number;
}

const VERDICT_PILL: Record<string, string> = {
  control: 'neutral',
  winning: 'good',
  losing: 'crit',
  no_difference: 'fu',
  insufficient_data: 'new',
};

const VERDICT_LABEL: Record<string, string> = {
  control: 'Control',
  winning: 'Winning',
  losing: 'Losing',
  no_difference: 'No difference',
  insufficient_data: 'Too early',
};

export function ExperimentsPanel({
  readout,
  campaigns,
  activeCampaignId,
  canEdit,
}: {
  readout: Readout;
  campaigns: { id: string; name: string }[];
  activeCampaignId: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  const detailById = new Map(readout.details.map((d) => [d.id, d]));
  const maxRate = Math.max(...readout.variants.map((v) => v.replyRate), 0.001);

  async function promote(variant: VariantRow) {
    setBusy(variant.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/experiments/${variant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promote: true }),
      });
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

  async function toggleActive(detail: VariantDetail) {
    setBusy(detail.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/experiments/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !detail.isActive }),
      });
      const json = await response.json();
      if (json.ok) {
        setMessage({
          text: detail.isActive
            ? `"${detail.name}" paused — no new leads will be assigned to it. Existing leads keep running.`
            : `"${detail.name}" is active again.`,
          kind: 'good',
        });
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {message && (
        <div className={`banner ${message.kind}`}>
          <span>{message.text}</span>
        </div>
      )}

      {campaigns.length > 0 && (
        <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 6 }}>
          <a
            href="/experiments"
            className={`ctrl sm ${!activeCampaignId ? 'primary' : ''}`}
          >
            Org-wide
          </a>
          {campaigns.map((c) => (
            <a
              key={c.id}
              href={`/experiments?campaignId=${c.id}`}
              className={`ctrl sm ${activeCampaignId === c.id ? 'primary' : ''}`}
            >
              {c.name}
            </a>
          ))}
        </div>
      )}

      {/* --- The headline reading ------------------------------------- */}
      <div
        className="card"
        style={{
          borderLeft: `3px solid ${
            readout.winnerId ? 'var(--good)' : readout.totalSent > 0 ? 'var(--warn)' : 'var(--line)'
          }`,
        }}
      >
        <div className="ch">
          <h3>{readout.winnerId ? 'You have a winner' : 'Where this test stands'}</h3>
          {canEdit && (
            <button className="ctrl primary sm" onClick={() => setShowCreate(true)}>
              + New variant
            </button>
          )}
        </div>

        <div style={{ fontSize: 13, lineHeight: 1.65 }}>{readout.summary}</div>

        {readout.variants.length >= 2 && (
          <div
            className="muted"
            style={{ fontSize: 11, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)', lineHeight: 1.7 }}
          >
            Judged on <b>reply rate</b>, not opens — Apple and Gmail pre-fetch images, so open
            counts are unreliable. Significance threshold p &lt; {readout.alpha.toFixed(3)}
            {readout.variants.length > 2 && ' (tightened because several variants are being compared at once)'}.
            {readout.recommendedSampleSize < 100000 && (
              <>
                {' '}
                Detecting a 30% improvement at this reply rate needs roughly{' '}
                <b>{readout.recommendedSampleSize.toLocaleString()}</b> sends per variant.
              </>
            )}
          </div>
        )}
      </div>

      {readout.variants.length === 0 ? (
        <div className="card">
          <div className="empty">
            No variants yet. Create two with genuinely different angles — a cost argument versus a
            speed argument, say — and new leads will be split between them automatically.
            <br />
            <br />
            Small wording tweaks are not worth testing. Reply rates are low enough that only large
            differences are ever detectable.
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="ch">
            <h3>Results</h3>
            <span className="hint">{readout.totalSent} sends measured</span>
          </div>

          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Variant</th>
                  <th>Sent</th>
                  <th>Replies</th>
                  <th>Reply rate</th>
                  <th style={{ width: 130 }}>vs control</th>
                  <th>Interested</th>
                  <th>Verdict</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {readout.variants.map((variant) => {
                  const detail = detailById.get(variant.id);
                  const isWinner = readout.winnerId === variant.id;

                  return (
                    <tr
                      key={variant.id}
                      style={isWinner ? { background: 'var(--good-soft)' } : undefined}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                          <b style={{ fontSize: 12.5 }}>{variant.name}</b>
                          {variant.isControl && <span className="pill neutral">control</span>}
                          {detail && !detail.isActive && <span className="pill crit">paused</span>}
                        </div>
                        {detail?.ctaStyle && (
                          <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>
                            CTA: {detail.ctaStyle}
                            {detail.targetLength ? ` · ${detail.targetLength}` : ''}
                          </div>
                        )}
                      </td>
                      <td className="num mono">{variant.sent}</td>
                      <td className="num mono">{variant.replied}</td>
                      <td className="mono" style={{ fontWeight: 700 }}>
                        {(variant.replyRate * 100).toFixed(1)}%
                      </td>
                      <td>
                        <div className="track" style={{ height: 8 }}>
                          <div
                            className={`fill ${variant.verdict === 'losing' ? 'c' : variant.verdict === 'winning' ? '' : 'w'}`}
                            style={{ width: `${(variant.replyRate / maxRate) * 100}%` }}
                          />
                        </div>
                        {variant.lift !== null && !variant.isControl && (
                          <div
                            className="mono"
                            style={{
                              fontSize: 10,
                              marginTop: 3,
                              color: variant.lift > 0 ? 'var(--good)' : 'var(--crit)',
                            }}
                          >
                            {variant.lift > 0 ? '+' : ''}
                            {(variant.lift * 100).toFixed(0)}%
                            {variant.pValue !== null && ` · p=${variant.pValue.toFixed(3)}`}
                          </div>
                        )}
                      </td>
                      <td className="num mono">{variant.interested}</td>
                      <td>
                        <span className={`pill ${VERDICT_PILL[variant.verdict] ?? 'neutral'}`}>
                          {VERDICT_LABEL[variant.verdict] ?? variant.verdict}
                        </span>
                      </td>
                      <td>
                        {canEdit && detail && (
                          <div className="row" style={{ gap: 5 }}>
                            {isWinner && (
                              <button
                                className="ctrl primary sm"
                                disabled={busy !== null}
                                onClick={() => void promote(variant)}
                              >
                                {busy === variant.id ? <span className="spin" /> : 'Promote'}
                              </button>
                            )}
                            {!variant.isControl && (
                              <button
                                className="ctrl sm"
                                disabled={busy !== null}
                                onClick={() => void toggleActive(detail)}
                              >
                                {detail.isActive ? 'Pause' : 'Resume'}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="stack" style={{ marginTop: 14, gap: 7 }}>
            {readout.variants.map((variant) => (
              <div
                key={variant.id}
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  lineHeight: 1.6,
                  paddingLeft: 10,
                  borderLeft: `2px solid ${
                    variant.verdict === 'winning'
                      ? 'var(--good)'
                      : variant.verdict === 'losing'
                        ? 'var(--crit)'
                        : 'var(--line)'
                  }`,
                }}
              >
                <b style={{ color: 'var(--ink)' }}>{variant.name}:</b> {variant.explanation}
              </div>
            ))}
          </div>
        </div>
      )}

      {showCreate && (
        <VariantModal
          campaignId={activeCampaignId}
          onClose={() => setShowCreate(false)}
          onDone={(text) => {
            setMessage({ text, kind: 'good' });
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function VariantModal({
  campaignId,
  onClose,
  onDone,
}: {
  campaignId: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState({
    name: '',
    description: '',
    angleInstructions: '',
    ctaStyle: '' as '' | 'call' | 'question' | 'resource',
    targetLength: '' as '' | 'short' | 'standard',
    weight: 1,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId,
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          angleInstructions: form.angleInstructions.trim() || undefined,
          ctaStyle: form.ctaStyle || undefined,
          targetLength: form.targetLength || undefined,
          weight: form.weight,
        }),
      });
      const json = await response.json();

      if (json.ok) {
        onDone(json.data.message);
        onClose();
      } else {
        setError(json.error);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((c) => ({ ...c, [key]: value }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New variant</h2>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Cost angle"
              required
              autoFocus
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="angle">What makes this variant different</label>
            <textarea
              id="angle"
              value={form.angleInstructions}
              rows={4}
              onChange={(e) => set('angleInstructions', e.target.value)}
              placeholder="Lead with the cost of hiring four people locally versus covering the same work offshore. Use a concrete number if the research supports one."
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5, lineHeight: 1.6 }}>
              Merged into the email prompt for leads on this variant. Make it a genuinely different
              argument — reply rates are too low for a reworded sentence to ever show up as a
              difference.
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
            <div>
              <label htmlFor="cta">Ask</label>
              <select id="cta" value={form.ctaStyle} onChange={(e) => set('ctaStyle', e.target.value as typeof form.ctaStyle)}>
                <option value="">Default</option>
                <option value="call">Ask for a call</option>
                <option value="question">Ask a question</option>
                <option value="resource">Offer something</option>
              </select>
            </div>
            <div>
              <label htmlFor="len">Length</label>
              <select
                id="len"
                value={form.targetLength}
                onChange={(e) => set('targetLength', e.target.value as typeof form.targetLength)}
              >
                <option value="">Default</option>
                <option value="short">Short (&lt;70 words)</option>
                <option value="standard">Standard (90–130)</option>
              </select>
            </div>
            <div>
              <label htmlFor="weight">Share</label>
              <input
                id="weight"
                type="number"
                min={1}
                max={100}
                value={form.weight}
                onChange={(e) => set('weight', Number(e.target.value))}
              />
            </div>
          </div>

          {error && (
            <div className="banner crit" style={{ marginBottom: 14 }}>
              <span>{error}</span>
            </div>
          )}

          <div className="row">
            <button type="submit" className="ctrl primary" disabled={submitting || !form.name.trim()}>
              {submitting ? <span className="spin" /> : 'Create variant'}
            </button>
            <button type="button" className="ctrl ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
