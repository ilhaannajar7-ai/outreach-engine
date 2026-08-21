'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatStatus } from '@/lib/format';

interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: string;
  targetRole: string | null;
  targetIndustry: string | null;
  targetLocation: string | null;
  maxFollowUps: number;
  followUp1DelayDays: number;
  followUp2DelayDays: number;
  toneInstructions: string | null;
  customPromptAdditions: string | null;
  createdAt: string;
  leadCount: number;
  contactedCount: number;
  repliedCount: number;
  interestedCount: number;
}

export function CampaignsPanel({
  campaigns,
  canEdit,
}: {
  campaigns: Campaign[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  async function setStatus(campaign: Campaign, status: string) {
    setBusy(campaign.id);
    setMessage(null);

    try {
      const response = await fetch(`/api/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const json = await response.json();

      if (json.ok) {
        setMessage({
          text:
            status === 'paused'
              ? `"${campaign.name}" paused. Scheduled follow-ups for its leads were cleared.`
              : `"${campaign.name}" is now ${status}.`,
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

      <div className="card">
        <div className="ch">
          <h3>Campaigns</h3>
          <span className="hint">{campaigns.length} total</span>
          {canEdit && (
            <button className="ctrl primary sm" onClick={() => setShowCreate(true)}>
              + New campaign
            </button>
          )}
        </div>

        {campaigns.length === 0 ? (
          <div className="empty">
            No campaigns yet. A campaign groups leads that share a target role and a follow-up
            cadence — and lets you give the AI extra instructions for that specific audience.
          </div>
        ) : (
          <div className="stack">
            {campaigns.map((campaign) => {
              const replyRate =
                campaign.contactedCount > 0
                  ? (campaign.repliedCount / campaign.contactedCount) * 100
                  : 0;

              return (
                <div
                  key={campaign.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderLeft: `3px solid ${campaignColor(campaign.status)}`,
                    borderRadius: 10,
                    padding: 14,
                    background: 'var(--panel-2)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <b style={{ fontSize: 13.5 }}>{campaign.name}</b>
                        <span className={`pill ${campaignPill(campaign.status)}`}>
                          {formatStatus(campaign.status)}
                        </span>
                      </div>

                      {campaign.description && (
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                          {campaign.description}
                        </div>
                      )}

                      <div
                        style={{
                          fontSize: 11.5,
                          color: 'var(--muted)',
                          marginTop: 6,
                          display: 'flex',
                          gap: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        {campaign.targetRole && <span>Role: {campaign.targetRole}</span>}
                        {campaign.targetIndustry && <span>Industry: {campaign.targetIndustry}</span>}
                        {campaign.targetLocation && <span>Location: {campaign.targetLocation}</span>}
                        <span>
                          {campaign.maxFollowUps} follow-up{campaign.maxFollowUps === 1 ? '' : 's'} ·
                          day {campaign.followUp1DelayDays}
                          {campaign.maxFollowUps > 1 && ` + ${campaign.followUp2DelayDays}`}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <Stat label="Leads" value={campaign.leadCount} />
                      <Stat label="Contacted" value={campaign.contactedCount} />
                      <Stat label="Replies" value={campaign.repliedCount} />
                      <Stat
                        label="Reply rate"
                        value={`${replyRate.toFixed(1)}%`}
                        tone={replyRate >= 3 ? 'good' : undefined}
                      />
                      <Stat
                        label="Interested"
                        value={campaign.interestedCount}
                        tone={campaign.interestedCount > 0 ? 'good' : undefined}
                      />
                    </div>
                  </div>

                  {canEdit && (
                    <div className="row" style={{ marginTop: 11, flexWrap: 'wrap' }}>
                      {campaign.status === 'draft' || campaign.status === 'paused' ? (
                        <button
                          className="ctrl primary sm"
                          onClick={() => void setStatus(campaign, 'active')}
                          disabled={busy !== null}
                        >
                          {busy === campaign.id ? <span className="spin" /> : 'Activate'}
                        </button>
                      ) : campaign.status === 'active' ? (
                        <button
                          className="ctrl sm"
                          onClick={() => void setStatus(campaign, 'paused')}
                          disabled={busy !== null}
                        >
                          {busy === campaign.id ? <span className="spin" /> : 'Pause'}
                        </button>
                      ) : null}

                      <button className="ctrl sm" onClick={() => setEditing(campaign)}>
                        Settings
                      </button>

                      <Link href={`/leads?campaignId=${campaign.id}`} className="ctrl sm ghost">
                        View leads →
                      </Link>

                      {campaign.status !== 'archived' && (
                        <button
                          className="ctrl danger sm"
                          style={{ marginLeft: 'auto' }}
                          onClick={() => void setStatus(campaign, 'archived')}
                          disabled={busy !== null}
                        >
                          Archive
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(showCreate || editing) && (
        <CampaignModal
          campaign={editing}
          onClose={() => {
            setShowCreate(false);
            setEditing(null);
          }}
          onDone={() => router.refresh()}
        />
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'good' }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>{label}</div>
      <div
        className="mono"
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: tone === 'good' ? 'var(--good)' : 'var(--ink)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function CampaignModal({
  campaign,
  onClose,
  onDone,
}: {
  campaign: Campaign | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    name: campaign?.name ?? '',
    description: campaign?.description ?? '',
    targetRole: campaign?.targetRole ?? '',
    targetIndustry: campaign?.targetIndustry ?? '',
    targetLocation: campaign?.targetLocation ?? '',
    maxFollowUps: campaign?.maxFollowUps ?? 2,
    followUp1DelayDays: campaign?.followUp1DelayDays ?? 4,
    followUp2DelayDays: campaign?.followUp2DelayDays ?? 7,
    customPromptAdditions: campaign?.customPromptAdditions ?? '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      targetRole: form.targetRole.trim() || undefined,
      targetIndustry: form.targetIndustry.trim() || undefined,
      targetLocation: form.targetLocation.trim() || undefined,
      maxFollowUps: form.maxFollowUps,
      followUp1DelayDays: form.followUp1DelayDays,
      followUp2DelayDays: form.followUp2DelayDays,
      customPromptAdditions: form.customPromptAdditions.trim() || undefined,
    };

    try {
      const response = await fetch(
        campaign ? `/api/campaigns/${campaign.id}` : '/api/campaigns',
        {
          method: campaign ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const json = await response.json();

      if (json.ok) {
        onDone();
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
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{campaign ? `Edit "${campaign.name}"` : 'New campaign'}</h2>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Q3 — Logistics finance teams"
              required
              autoFocus
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="description">Description</label>
            <input
              id="description"
              type="text"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="seclabel" style={{ marginTop: 18 }}>
            Targeting (for your reference and the AI&apos;s context)
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            <div>
              <label htmlFor="role">Target role</label>
              <input
                id="role"
                type="text"
                value={form.targetRole}
                onChange={(e) => set('targetRole', e.target.value)}
                placeholder="CFO, Finance Manager"
              />
            </div>
            <div>
              <label htmlFor="industry">Industry</label>
              <input
                id="industry"
                type="text"
                value={form.targetIndustry}
                onChange={(e) => set('targetIndustry', e.target.value)}
                placeholder="Logistics"
              />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="location">Location</label>
            <input
              id="location"
              type="text"
              value={form.targetLocation}
              onChange={(e) => set('targetLocation', e.target.value)}
              placeholder="United Kingdom"
            />
          </div>

          <div className="seclabel" style={{ marginTop: 18 }}>
            Follow-up cadence
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 6 }}>
            <div>
              <label htmlFor="maxFollowUps">Max follow-ups</label>
              <select
                id="maxFollowUps"
                value={form.maxFollowUps}
                onChange={(e) => set('maxFollowUps', Number(e.target.value))}
              >
                <option value={0}>None</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </div>
            <div>
              <label htmlFor="fu1">First after (days)</label>
              <input
                id="fu1"
                type="number"
                min={1}
                max={60}
                value={form.followUp1DelayDays}
                onChange={(e) => set('followUp1DelayDays', Number(e.target.value))}
              />
            </div>
            <div>
              <label htmlFor="fu2">Second after (days)</label>
              <input
                id="fu2"
                type="number"
                min={1}
                max={60}
                value={form.followUp2DelayDays}
                onChange={(e) => set('followUp2DelayDays', Number(e.target.value))}
                disabled={form.maxFollowUps < 2}
              />
            </div>
          </div>

          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.6 }}>
            Three is the maximum by design — four touches including the first email. Past that,
            replies collapse while spam complaints climb, and a domain gets filtered once
            complaints pass 0.3%. The sequence also stops on its own if nothing has been opened
            by the third touch.
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="prompt">Extra AI instructions for this campaign</label>
            <textarea
              id="prompt"
              value={form.customPromptAdditions}
              onChange={(e) => set('customPromptAdditions', e.target.value)}
              rows={4}
              placeholder="e.g. These are UK companies — use British spelling. Emphasise compliance and data residency."
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
              Merged into the email-generation prompt for leads in this campaign only.
            </div>
          </div>

          {error && (
            <div className="banner crit" style={{ marginBottom: 14 }}>
              <span>{error}</span>
            </div>
          )}

          <div className="row">
            <button type="submit" className="ctrl primary" disabled={submitting || !form.name.trim()}>
              {submitting ? <span className="spin" /> : campaign ? 'Save changes' : 'Create campaign'}
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

function campaignPill(status: string): string {
  return (
    { active: 'good', draft: 'new', paused: 'fu', completed: 'rev', archived: 'neutral' }[status] ??
    'neutral'
  );
}

function campaignColor(status: string): string {
  return (
    {
      active: 'var(--good)',
      draft: 'var(--blue)',
      paused: 'var(--warn)',
      completed: 'var(--violet)',
      archived: 'var(--line-strong)',
    }[status] ?? 'var(--line)'
  );
}
