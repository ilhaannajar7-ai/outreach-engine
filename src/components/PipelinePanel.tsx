'use client';

/**
 * Live pipeline — every lead in flight, why it was targeted, and what is next.
 *
 * Auto-refreshes so it can be left open on a second screen. The row expands to
 * show the targeting reason and the research hook, because "why is this lead
 * here" is the question this page exists to answer.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface Item {
  leadId: string;
  status: string;
  createdAt: string;
  firstContactedAt: string | null;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  repliedAt: string | null;
  followUpCount: number;
  maxFollowUps: number;
  followUpDue: boolean;
  requiresAttention: boolean;
  attentionReason: string | null;
  companyName: string;
  companyDomain: string | null;
  industry: string | null;
  sizeRange: string | null;
  location: string | null;
  hiringSignal: string | null;
  hiringSignalSource: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string;
  emailVerified: boolean;
  campaignName: string | null;
  variantName: string | null;
  fitScore: number | null;
  hookQuality: number | null;
  researchSummary: string | null;
  topHook: { observation: string; score: number } | null;
  sentCount: number;
  pendingDraftId: string | null;
  lastOpenCount: number;
}

interface Counts {
  total: number;
  newLeads: number;
  awaitingApproval: number;
  contacted: number;
  followUpsScheduled: number;
  followUpsDue: number;
  replied: number;
  needsAttention: number;
}

type Filter = 'all' | 'new' | 'awaiting' | 'contacted' | 'followups' | 'replied' | 'attention';

const REFRESH_MS = 60_000;

export function PipelinePanel() {
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/pipeline?limit=200', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok) {
        setItems(json.data.items);
        setCounts(json.data.counts);
        setFetchedAt(json.data.fetchedAt);
      }
    } catch {
      // Keep showing the last good data rather than blanking the page.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const shown = items.filter((i) => {
    switch (filter) {
      case 'new':
        return ['new', 'researching', 'researched', 'generating'].includes(i.status);
      case 'awaiting':
        return Boolean(i.pendingDraftId);
      case 'contacted':
        return Boolean(i.firstContactedAt) && !i.repliedAt;
      case 'followups':
        return Boolean(i.nextFollowUpAt) && !i.repliedAt;
      case 'replied':
        return Boolean(i.repliedAt);
      case 'attention':
        return i.requiresAttention;
      default:
        return true;
    }
  });

  if (loading) return <div className="card"><div className="empty">Loading pipeline…</div></div>;

  return (
    <>
      {counts && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: 8 }}>
          <Chip label="All" value={counts.total} active={filter === 'all'} onClick={() => setFilter('all')} />
          <Chip label="New" value={counts.newLeads} active={filter === 'new'} onClick={() => setFilter('new')} />
          <Chip
            label="Awaiting approval"
            value={counts.awaitingApproval}
            active={filter === 'awaiting'}
            onClick={() => setFilter('awaiting')}
            color="var(--accent)"
          />
          <Chip label="Contacted" value={counts.contacted} active={filter === 'contacted'} onClick={() => setFilter('contacted')} />
          <Chip
            label="Follow-ups"
            value={counts.followUpsScheduled}
            sub={counts.followUpsDue > 0 ? `${counts.followUpsDue} due` : undefined}
            active={filter === 'followups'}
            onClick={() => setFilter('followups')}
          />
          <Chip label="Replied" value={counts.replied} active={filter === 'replied'} onClick={() => setFilter('replied')} color="var(--good)" />
          <Chip
            label="Needs attention"
            value={counts.needsAttention}
            active={filter === 'attention'}
            onClick={() => setFilter('attention')}
            color={counts.needsAttention > 0 ? 'var(--warn)' : undefined}
          />
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>Pipeline</h3>
          <span className="hint">
            {shown.length} shown{fetchedAt ? ` · updated ${timeAgo(fetchedAt)}` : ''} · auto-refreshing
          </span>
          <button className="ctrl sm" onClick={() => void load()}>
            ↻ Refresh
          </button>
        </div>

        {shown.length === 0 ? (
          <div className="empty">Nothing in this view.</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Stage</th>
                  <th>Targeted for</th>
                  <th>Next</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <>
                    <tr key={i.leadId}>
                      <td style={{ fontWeight: 600, fontSize: 12.5 }}>
                        {i.companyName}
                        {i.companyDomain && (
                          <div className="mono muted" style={{ fontSize: 10.5, fontWeight: 400 }}>
                            {i.companyDomain}
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {i.contactName ?? <span className="muted">—</span>}
                        <div className="mono muted" style={{ fontSize: 10.5 }}>
                          {i.contactEmail}
                          {!i.emailVerified && <span className="pill crit" style={{ marginLeft: 5, padding: '0 5px' }}>unverified</span>}
                        </div>
                      </td>
                      <td>
                        <span className={`pill ${stagePill(i)}`}>{stageLabel(i)}</span>
                        {i.sentCount > 0 && (
                          <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                            {i.sentCount} sent · {i.lastOpenCount} opens
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 11.5, maxWidth: 260 }}>
                        {i.hiringSignal ? (
                          <span>{truncate(i.hiringSignal, 90)}</span>
                        ) : (
                          <span className="muted">No signal recorded</span>
                        )}
                      </td>
                      <td style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                        {i.repliedAt ? (
                          <span className="pill good">Replied</span>
                        ) : i.pendingDraftId ? (
                          <Link href="/queue" className="act">
                            Approve →
                          </Link>
                        ) : i.nextFollowUpAt ? (
                          i.followUpDue ? (
                            <span className="pill good">Follow-up due</span>
                          ) : (
                            <span className="muted">
                              F/U {i.followUpCount + 1}/{i.maxFollowUps} ·{' '}
                              {new Date(i.nextFollowUpAt).toLocaleDateString()}
                            </span>
                          )
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button
                          className="ctrl sm"
                          onClick={() => setExpanded(expanded === i.leadId ? null : i.leadId)}
                        >
                          {expanded === i.leadId ? 'Hide' : 'Details'}
                        </button>{' '}
                        <Link href={`/leads/${i.leadId}`} className="act">
                          Open →
                        </Link>
                      </td>
                    </tr>

                    {expanded === i.leadId && (
                      <tr key={`${i.leadId}-detail`}>
                        <td colSpan={6} style={{ background: 'var(--panel-2)' }}>
                          <div style={{ padding: '10px 4px', fontSize: 12, lineHeight: 1.7 }}>
                            <Row label="Contact title" value={i.contactTitle} />
                            <Row label="Industry / size / location" value={[i.industry, i.sizeRange, i.location].filter(Boolean).join(' · ')} />
                            <Row label="Campaign" value={i.campaignName} />
                            <Row label="Strategy variant" value={i.variantName} />
                            <Row
                              label="Why targeted"
                              value={i.hiringSignal ? `${i.hiringSignal}${i.hiringSignalSource ? ` (source: ${i.hiringSignalSource})` : ''}` : null}
                            />
                            <Row
                              label="Research"
                              value={
                                i.fitScore != null
                                  ? `Fit ${i.fitScore}/100 · hook quality ${i.hookQuality ?? '—'}/100`
                                  : 'Not researched yet'
                              }
                            />
                            <Row label="Best hook" value={i.topHook ? `${i.topHook.observation} (${i.topHook.score}/100)` : null} />
                            <Row label="Summary" value={i.researchSummary ? truncate(i.researchSummary, 320) : null} />
                            {i.requiresAttention && i.attentionReason && (
                              <div className="banner" style={{ marginTop: 8 }}>
                                ⚠️ <span>{i.attentionReason}</span>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 10 }}>
      <span className="muted" style={{ fontWeight: 600 }}>
        {label}
      </span>
      <span>{value}</span>
    </div>
  );
}

function Chip({
  label,
  value,
  sub,
  active,
  onClick,
  color,
}: {
  label: string;
  value: number;
  sub?: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
        borderRadius: 9,
        padding: '9px 11px',
        background: active ? 'var(--accent-soft)' : 'var(--panel)',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.15rem', fontWeight: 800, color: color ?? 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
        {sub && <small style={{ fontSize: '0.55em', color: 'var(--warn)', marginLeft: 5 }}>{sub}</small>}
      </div>
    </button>
  );
}

function stageLabel(i: Item): string {
  if (i.repliedAt) return 'Replied';
  if (i.pendingDraftId) return 'Awaiting approval';
  if (i.nextFollowUpAt) return `Follow-up ${i.followUpCount + 1}`;
  if (i.firstContactedAt) return 'Contacted';
  return i.status.replace(/_/g, ' ');
}

function stagePill(i: Item): string {
  if (i.repliedAt) return 'good';
  if (i.pendingDraftId) return 'rev';
  if (i.requiresAttention) return 'crit';
  if (i.nextFollowUpAt) return 'fu';
  return 'neutral';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}
