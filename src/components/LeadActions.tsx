'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

/**
 * The per-lead action bar.
 *
 * Only ever queues work — research and generation happen in the worker, and
 * nothing here sends an email. Sending requires approval in the queue.
 */
export function LeadActions({
  leadId,
  hasResearch,
  status,
  isSuppressed,
}: {
  leadId: string;
  hasResearch: boolean;
  status: string;
  isSuppressed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  async function run(action: 'research' | 'generate', body?: Record<string, unknown>) {
    setBusy(action);
    setMessage(null);

    try {
      const response = await fetch(`/api/leads/${leadId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const json = await response.json();

      setMessage({ text: json.ok ? json.data.message : json.error, kind: json.ok ? 'good' : 'crit' });
      if (json.ok) router.refresh();
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(null);
    }
  }

  async function clearAttention() {
    setBusy('clear');
    try {
      await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requiresAttention: false }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (isSuppressed) {
    return (
      <div className="banner crit">
        <span>
          This contact has unsubscribed or been suppressed. No further email can be generated or
          sent to them — that is permanent and applies across every campaign.
        </span>
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

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button
            className={`ctrl ${!hasResearch ? 'primary' : ''}`}
            onClick={() => void run('research', { force: hasResearch })}
            disabled={busy !== null}
          >
            {busy === 'research' ? <span className="spin" /> : hasResearch ? 'Re-run research' : 'Research company'}
          </button>

          <button
            className="ctrl primary"
            onClick={() => void run('generate')}
            disabled={busy !== null || !hasResearch}
            title={hasResearch ? undefined : 'Research the company first'}
          >
            {busy === 'generate' ? <span className="spin" /> : 'Generate email'}
          </button>

          {status === 'ready_to_contact' && (
            <Link href="/queue" className="ctrl">
              Open approval queue →
            </Link>
          )}

          <button
            className="ctrl ghost"
            onClick={() => void clearAttention()}
            disabled={busy !== null}
            style={{ marginLeft: 'auto' }}
          >
            Mark as handled
          </button>
        </div>

        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Research and generation run in the background and cost AI credits. Drafts always go to the
          approval queue — nothing sends without you.
        </div>
      </div>
    </>
  );
}
