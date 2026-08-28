'use client';

/**
 * Follow-up pipeline — what is queued, and the controls to change it.
 *
 * A follow-up lives as a date on the lead until its wait elapses; only then is
 * the draft written, and it still needs approval. Both states are shown, because
 * "scheduled for Tuesday" and "written and waiting for you" need different
 * actions from you.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface Scheduled {
  leadId: string;
  companyName: string;
  contactName: string | null;
  contactEmail: string;
  status: string;
  followUpCount: number;
  maxFollowUps: number;
  nextFollowUpAt: string | null;
  lastContactedAt: string | null;
  campaignName: string | null;
  isDue: boolean;
}

interface PendingDraft {
  emailId: string;
  leadId: string;
  kind: string;
  subject: string;
  companyName: string;
  contactEmail: string;
  createdAt: string;
}

interface FollowUpData {
  scheduled: Scheduled[];
  pendingDrafts: PendingDraft[];
  counts: { scheduled: number; due: number; awaitingApproval: number };
}

export function FollowUpPanel({ canEdit = true }: { canEdit?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<FollowUpData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const [newDate, setNewDate] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/follow-ups', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok) setData(json.data as FollowUpData);
      else setMessage({ text: json.error ?? 'Could not load follow-ups.', kind: 'crit' });
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 120_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(leadId: string, action: 'reschedule' | 'cancel' | 'draft_now', when?: string) {
    setBusyId(leadId);
    setMessage(null);
    try {
      const res = await fetch('/api/follow-ups', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId,
          action,
          ...(when ? { nextFollowUpAt: new Date(when).toISOString() } : {}),
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setMessage({ text: json.data.message, kind: 'good' });
        setRescheduling(null);
        await load();
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="card">
        <div className="ch">
          <h3>Follow-ups</h3>
        </div>
        <div className="empty">Loading…</div>
      </div>
    );
  }

  const counts = data?.counts;

  return (
    <div className="card">
      <div className="ch">
        <h3>Follow-up pipeline</h3>
        <span className="hint">
          {counts
            ? `${counts.scheduled} scheduled · ${counts.due} due · ${counts.awaitingApproval} awaiting approval`
            : ''}
        </span>
        <button className="ctrl sm" onClick={() => void load()}>
          ↻ Refresh
        </button>
      </div>

      {message && (
        <div className={`banner ${message.kind}`} style={{ marginBottom: 12 }}>
          <span>{message.text}</span>
        </div>
      )}

      {data && data.pendingDrafts.length > 0 && (
        <div className="banner good" style={{ marginBottom: 12 }}>
          ✉️{' '}
          <span>
            <b>
              {data.pendingDrafts.length} follow-up draft
              {data.pendingDrafts.length === 1 ? '' : 's'} written and waiting for approval.
            </b>{' '}
            <Link href="/queue" className="act">
              Review queue →
            </Link>
          </span>
        </div>
      )}

      {!data || data.scheduled.length === 0 ? (
        <div className="empty">
          No follow-ups scheduled. One is scheduled automatically after each initial email sends.
        </div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Step</th>
                <th>Due</th>
                {canEdit && <th aria-label="actions" />}
              </tr>
            </thead>
            <tbody>
              {data.scheduled.map((row) => {
                const due = row.nextFollowUpAt ? new Date(row.nextFollowUpAt) : null;
                return (
                  <tr key={row.leadId}>
                    <td style={{ fontWeight: 600, fontSize: 12.5 }}>
                      {row.companyName}
                      {row.campaignName && (
                        <span className="muted" style={{ fontWeight: 400 }}> · {row.campaignName}</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {row.contactName ?? row.contactEmail}
                    </td>
                    <td>
                      <span className="pill fu">
                        {row.followUpCount + 1} of {row.maxFollowUps}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                      {due ? (
                        row.isDue ? (
                          <span className="pill good">Due now</span>
                        ) : (
                          <span className="muted">{due.toLocaleDateString()}</span>
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                    {canEdit && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {rescheduling === row.leadId ? (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <input
                              type="date"
                              value={newDate}
                              onChange={(e) => setNewDate(e.target.value)}
                              style={{ width: 150 }}
                            />
                            <button
                              className="ctrl sm primary"
                              disabled={!newDate || busyId === row.leadId}
                              onClick={() => void act(row.leadId, 'reschedule', newDate)}
                            >
                              Save
                            </button>
                            <button className="ctrl sm ghost" onClick={() => setRescheduling(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button
                              className="ctrl sm"
                              disabled={busyId === row.leadId}
                              onClick={() => void act(row.leadId, 'draft_now')}
                              title="Write this follow-up now instead of waiting"
                            >
                              Draft now
                            </button>
                            <button
                              className="ctrl sm"
                              disabled={busyId === row.leadId}
                              onClick={() => {
                                setRescheduling(row.leadId);
                                setNewDate(
                                  row.nextFollowUpAt
                                    ? new Date(row.nextFollowUpAt).toISOString().slice(0, 10)
                                    : '',
                                );
                              }}
                            >
                              Reschedule
                            </button>
                            <button
                              className="ctrl sm danger"
                              disabled={busyId === row.leadId}
                              onClick={() => void act(row.leadId, 'cancel')}
                              title="Stop following up with this lead"
                            >
                              Stop
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
        Follow-ups stop automatically when someone replies, unsubscribes, or shows no opens after
        two touches. Each one is written by the AI and still waits for your approval.
      </div>
    </div>
  );
}
