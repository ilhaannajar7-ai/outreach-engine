'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatStatus, statusPill } from '@/lib/format';

interface LeadRow {
  id: string;
  status: string;
  followUpCount: number;
  nextFollowUpAt: string | null;
  requiresAttention: boolean;
  attentionReason: string | null;
  researchId: string | null;
  lastError: string | null;
  createdAt: string;
  companyName: string;
  companyDomain: string | null;
  companyIndustry: string | null;
  hiringSignal: string | null;
  contactName: string | null;
  contactEmail: string;
  contactTitle: string | null;
  emailVerified: boolean;
  isUnsubscribed: boolean;
}

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'researched', label: 'Researched' },
  { value: 'ready_to_contact', label: 'Ready' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'replied', label: 'Replied' },
  { value: 'interested', label: 'Interested' },
  { value: 'error', label: 'Errors' },
];

export function LeadsTable({
  leads,
  total,
  page,
  limit,
  activeStatus,
  campaignId = null,
  budgetExceeded,
}: {
  leads: LeadRow[];
  total: number;
  page: number;
  limit: number;
  activeStatus: string;
  campaignId?: string | null;
  budgetExceeded: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);
  const [showImport, setShowImport] = useState(false);

  async function act(leadId: string, action: 'research' | 'generate') {
    setBusy(`${leadId}:${action}`);
    setMessage(null);

    try {
      const response = await fetch(`/api/leads/${leadId}/${action}`, { method: 'POST' });
      const json = await response.json();

      setMessage({ text: json.ok ? json.data.message : json.error, kind: json.ok ? 'good' : 'crit' });
      if (json.ok) router.refresh();
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(null);
    }
  }

  const totalPages = Math.ceil(total / limit);

  /**
   * Build a leads URL preserving whichever filters are not being changed —
   * otherwise clicking a status chip would silently drop the campaign filter.
   */
  function leadsUrl(overrides: { status?: string; page?: number }): string {
    const query = new URLSearchParams();
    const status = overrides.status ?? activeStatus;
    if (status && status !== 'all') query.set('status', status);
    if (campaignId) query.set('campaignId', campaignId);
    if (overrides.page && overrides.page > 1) query.set('page', String(overrides.page));
    const qs = query.toString();
    return qs ? `/leads?${qs}` : '/leads';
  }

  return (
    <>
      {campaignId && (
        <div className="banner good">
          <span>
            Showing leads from one campaign only.{' '}
            <Link href="/leads" className="act">
              Clear filter →
            </Link>
          </span>
        </div>
      )}

      {message && (
        <div className={`banner ${message.kind}`}>
          <span>{message.text}</span>
        </div>
      )}

      {budgetExceeded && (
        <div className="banner crit">
          ⛔{' '}
          <span>
            <b>AI budget exhausted</b> — research and email generation are blocked until you raise
            the cap in{' '}
            <Link href="/settings/ai" className="act">
              AI configuration
            </Link>
            .
          </span>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>Leads</h3>
          <span className="hint">{total} total</span>
          <button className="ctrl sm" onClick={() => setShowImport(true)}>
            Import CSV
          </button>
        </div>

        <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 6 }}>
          {STATUS_FILTERS.map((filter) => (
            <Link
              key={filter.value}
              href={leadsUrl({ status: filter.value })}
              className={`ctrl sm ${activeStatus === filter.value ? 'primary' : ''}`}
            >
              {filter.label}
            </Link>
          ))}
        </div>

        {leads.length === 0 ? (
          <div className="empty">
            No leads here yet. Import a CSV to get started — it needs an email column and a company
            or domain column.
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Signal</th>
                  <th>Next step</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{lead.companyName}</div>
                      {lead.companyDomain && (
                        <div className="mono muted" style={{ fontSize: 10.5 }}>
                          {lead.companyDomain}
                        </div>
                      )}
                    </td>
                    <td>
                      <div>{lead.contactName ?? '—'}</div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {lead.contactTitle ?? lead.contactEmail}
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${statusPill(lead.status)}`}>
                        {formatStatus(lead.status)}
                      </span>
                      {lead.isUnsubscribed && (
                        <div style={{ marginTop: 3 }}>
                          <span className="pill crit">Unsubscribed</span>
                        </div>
                      )}
                    </td>
                    <td className="muted" style={{ maxWidth: 200 }}>
                      {lead.hiringSignal ?? '—'}
                    </td>
                    <td className="muted" style={{ fontSize: 11.5 }}>
                      {nextStep(lead)}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {lead.isUnsubscribed ? (
                        <span className="muted" style={{ fontSize: 11 }}>
                          No action
                        </span>
                      ) : !lead.researchId ? (
                        <button
                          className="ctrl sm"
                          onClick={() => void act(lead.id, 'research')}
                          disabled={busy !== null || budgetExceeded}
                        >
                          {busy === `${lead.id}:research` ? <span className="spin" /> : 'Research'}
                        </button>
                      ) : lead.status === 'researched' ? (
                        <button
                          className="ctrl primary sm"
                          onClick={() => void act(lead.id, 'generate')}
                          disabled={busy !== null || budgetExceeded}
                        >
                          {busy === `${lead.id}:generate` ? <span className="spin" /> : 'Generate email'}
                        </button>
                      ) : null}{' '}
                      <Link href={`/leads/${lead.id}`} className="act">
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
            {page > 1 && (
              <Link href={leadsUrl({ page: page - 1 })} className="ctrl sm">
                ← Previous
              </Link>
            )}
            <span className="muted mono" style={{ fontSize: 11.5 }}>
              Page {page} of {totalPages}
            </span>
            {page < totalPages && (
              <Link href={leadsUrl({ page: page + 1 })} className="ctrl sm">
                Next →
              </Link>
            )}
          </div>
        )}
      </div>

      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={() => router.refresh()} />}
    </>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    imported?: number;
    duplicates?: number;
    errors?: { row: number; reason: string }[];
  } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;

    setUploading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/leads/import', { method: 'POST', body: formData });
      const json = await response.json();

      if (json.ok) {
        setResult({
          ok: true,
          message: json.data.message,
          imported: json.data.imported,
          duplicates: json.data.duplicates,
          errors: json.data.errors,
        });
        onDone();
      } else {
        setResult({ ok: false, message: json.error });
      }
    } catch {
      setResult({ ok: false, message: 'Could not reach the server.' });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Import leads from CSV</h2>

        {result?.ok ? (
          <>
            <div className="banner good" style={{ marginBottom: 14 }}>
              <span>{result.message}</span>
            </div>
            <div style={{ fontSize: 12.5, marginBottom: 14 }}>
              <div>
                Imported: <b>{result.imported}</b>
              </div>
              <div>
                Already present: <b>{result.duplicates}</b>
              </div>
              {result.errors && result.errors.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="seclabel">Rows skipped</div>
                  <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 11.5 }}>
                    {result.errors.map((error) => (
                      <div key={error.row} className="muted">
                        Row {error.row}: {error.reason}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button className="ctrl primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="csv">CSV file</label>
              <input
                id="csv"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.6 }}>
                Required: an <b>email</b> column, and a <b>company</b> or <b>domain</b> column.
                <br />
                Optional: name, title, industry, size, location, and a note used as the hiring
                signal.
                <br />
                Duplicate contacts are skipped automatically, so re-importing is safe.
              </div>
            </div>

            {result && !result.ok && (
              <div className="banner crit" style={{ marginBottom: 14 }}>
                <span>{result.message}</span>
              </div>
            )}

            <div className="row">
              <button type="submit" className="ctrl primary" disabled={uploading || !file}>
                {uploading ? <span className="spin" /> : 'Import'}
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

function nextStep(lead: LeadRow): string {
  if (lead.isUnsubscribed) return 'Suppressed — no further contact';
  if (lead.attentionReason) return lead.attentionReason;
  if (lead.lastError) return `Error: ${lead.lastError.slice(0, 60)}`;
  if (!lead.researchId) return 'Needs research';
  if (lead.status === 'researched') return 'Ready to generate an email';
  if (lead.status === 'ready_to_contact') return 'Draft waiting in the approval queue';
  if (lead.nextFollowUpAt) {
    const due = new Date(lead.nextFollowUpAt);
    return due <= new Date() ? 'Follow-up due now' : `Follow-up ${due.toLocaleDateString()}`;
  }
  return '—';
}
