'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export interface Draft {
  id: string;
  kind: string;
  subject: string;
  bodyText: string;
  toAddress: string;
  model: string | null;
  costUsd: string | null;
  createdAt: string;
  wasEditedByHuman: boolean;
  leadId: string;
  companyName: string;
  companyDomain: string | null;
  companyIndustry: string | null;
  hiringSignal: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string;
  emailVerified: boolean;
}

/**
 * Batch review UI.
 *
 * The design goal is a 10-minute daily pass: read each draft in place, edit
 * inline if needed, and approve the rest in one action. Selection state drives
 * a bulk approve so the common case is two clicks, not fifty.
 */
export function ApprovalQueue({
  drafts,
  capacityToday,
}: {
  drafts: Draft[];
  capacityToday: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { subject: string; bodyText: string }>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) =>
      current.size === drafts.length ? new Set() : new Set(drafts.map((d) => d.id)),
    );
  }

  async function approveOne(draft: Draft) {
    setBusy(true);
    setMessage(null);

    const edit = edits[draft.id];

    try {
      const response = await fetch(`/api/emails/${draft.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edit ? { subject: edit.subject, bodyText: edit.bodyText } : {}),
      });
      const json = await response.json();

      if (json.ok) {
        setMessage({ text: `Approved and queued for ${draft.companyName}.`, kind: 'good' });
        setEditing(null);
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(false);
    }
  }

  async function rejectOne(draft: Draft) {
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/emails/${draft.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Rejected during review', closeLead: false }),
      });
      const json = await response.json();

      if (json.ok) {
        setMessage({ text: `Rejected. ${draft.companyName} returns to the leads list.`, kind: 'good' });
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(false);
    }
  }

  async function approveSelected() {
    if (selected.size === 0) return;

    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch('/api/emails/bulk-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailIds: [...selected] }),
      });
      const json = await response.json();

      if (json.ok) {
        const { approved, willSendToday, willSendLater, skipped } = json.data;
        setMessage({
          text:
            `Approved ${approved}. ${willSendToday} will send today` +
            (willSendLater > 0 ? `, ${willSendLater} tomorrow (daily cap).` : '.') +
            (skipped.length > 0 ? ` ${skipped.length} skipped.` : ''),
          kind: 'good',
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(false);
    }
  }

  if (drafts.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          Nothing waiting for approval. Generate emails from the{' '}
          <Link href="/leads" className="act">
            Leads page
          </Link>{' '}
          to fill this queue.
        </div>
      </div>
    );
  }

  return (
    <>
      {message && (
        <div className={`banner ${message.kind}`}>
          <span>{message.text}</span>
        </div>
      )}

      {selected.size > capacityToday && (
        <div className="banner">
          ⚠️{' '}
          <span>
            You&apos;ve selected <b>{selected.size}</b> but only <b>{capacityToday}</b> can send
            today. The rest are queued and send tomorrow — nothing is lost.
          </span>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>
            {drafts.length} draft{drafts.length === 1 ? '' : 's'} awaiting approval
          </h3>
          <span className="hint">{selected.size} selected</span>
          <button className="ctrl sm" onClick={toggleAll}>
            {selected.size === drafts.length ? 'Clear all' : 'Select all'}
          </button>
          <button
            className="ctrl primary sm"
            onClick={() => void approveSelected()}
            disabled={busy || selected.size === 0}
          >
            {busy ? <span className="spin" /> : `Approve ${selected.size || ''} & send`}
          </button>
        </div>

        <div className="stack">
          {drafts.map((draft) => {
            const isEditing = editing === draft.id;
            const edit = edits[draft.id];
            const subject = edit?.subject ?? draft.subject;
            const body = edit?.bodyText ?? draft.bodyText;
            const isDirty = Boolean(edit) && (edit!.subject !== draft.subject || edit!.bodyText !== draft.bodyText);

            return (
              <div
                key={draft.id}
                style={{
                  border: '1px solid var(--line)',
                  borderLeft: `3px solid ${selected.has(draft.id) ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 10,
                  padding: 14,
                  background: 'var(--panel-2)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                  <input
                    type="checkbox"
                    checked={selected.has(draft.id)}
                    onChange={() => toggle(draft.id)}
                    aria-label={`Select draft for ${draft.companyName}`}
                    style={{ width: 'auto', marginTop: 3 }}
                  />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <b style={{ fontSize: 13.5 }}>{draft.companyName}</b>
                      <span className={`pill ${draft.kind === 'initial' ? 'new' : 'fu'}`}>
                        {draft.kind === 'initial' ? 'Initial' : draft.kind.replace(/_/g, ' ')}
                      </span>
                      {!draft.emailVerified && (
                        <span className="pill crit" title="Address not verified by the enrichment provider">
                          Unverified
                        </span>
                      )}
                      {isDirty && <span className="pill rev">Edited</span>}
                    </div>

                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      {draft.contactName ?? draft.contactEmail}
                      {draft.contactTitle && ` · ${draft.contactTitle}`}
                      {' · '}
                      <span className="mono">{draft.toAddress}</span>
                    </div>

                    {draft.hiringSignal && (
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                        <b>Signal:</b> {draft.hiringSignal}
                      </div>
                    )}
                  </div>

                  <Link href={`/leads/${draft.leadId}`} className="act" style={{ whiteSpace: 'nowrap' }}>
                    Lead →
                  </Link>
                </div>

                {isEditing ? (
                  <>
                    <div style={{ marginBottom: 10 }}>
                      <label htmlFor={`subject-${draft.id}`}>Subject</label>
                      <input
                        id={`subject-${draft.id}`}
                        type="text"
                        value={subject}
                        onChange={(e) =>
                          setEdits((current) => ({
                            ...current,
                            [draft.id]: { subject: e.target.value, bodyText: body },
                          }))
                        }
                      />
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <label htmlFor={`body-${draft.id}`}>Body</label>
                      <textarea
                        id={`body-${draft.id}`}
                        value={body}
                        rows={10}
                        onChange={(e) =>
                          setEdits((current) => ({
                            ...current,
                            [draft.id]: { subject, bodyText: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </>
                ) : (
                  <div
                    style={{
                      background: 'var(--panel)',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      padding: '11px 13px',
                    }}
                  >
                    <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 7 }}>{subject}</div>
                    <div
                      style={{
                        fontSize: 12.5,
                        lineHeight: 1.65,
                        color: 'var(--ink)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {body}
                    </div>
                  </div>
                )}

                <div className="row" style={{ marginTop: 11 }}>
                  <button
                    className="ctrl primary sm"
                    onClick={() => void approveOne(draft)}
                    disabled={busy}
                  >
                    Approve &amp; send
                  </button>
                  <button
                    className="ctrl sm"
                    onClick={() => setEditing(isEditing ? null : draft.id)}
                    disabled={busy}
                  >
                    {isEditing ? 'Done editing' : 'Edit'}
                  </button>
                  <button className="ctrl danger sm" onClick={() => void rejectOne(draft)} disabled={busy}>
                    Reject
                  </button>

                  <span
                    className="mono"
                    style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--faint)' }}
                  >
                    {draft.model} · ${Number(draft.costUsd ?? 0).toFixed(4)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
