'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface OrganizationData {
  name: string;
  valueProposition: string | null;
  servicesOffered: string | null;
  targetIndustries: string | null;
  senderName: string | null;
  senderTitle: string | null;
  calendarLink: string | null;
}

export function OrganizationForm({
  organization,
  canEdit,
}: {
  organization: OrganizationData;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: organization.name,
    valueProposition: organization.valueProposition ?? '',
    servicesOffered: organization.servicesOffered ?? '',
    targetIndustries: organization.targetIndustries ?? '',
    senderName: organization.senderName ?? '',
    senderTitle: organization.senderTitle ?? '',
    calendarLink: organization.calendarLink ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  const isDirty =
    form.name !== organization.name ||
    form.valueProposition !== (organization.valueProposition ?? '') ||
    form.servicesOffered !== (organization.servicesOffered ?? '') ||
    form.targetIndustries !== (organization.targetIndustries ?? '') ||
    form.senderName !== (organization.senderName ?? '') ||
    form.senderTitle !== (organization.senderTitle ?? '') ||
    form.calendarLink !== (organization.calendarLink ?? '');

  const set = <K extends keyof typeof form>(key: K, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await response.json();

      setMessage({ text: json.ok ? json.data.message : json.error, kind: json.ok ? 'good' : 'crit' });
      if (json.ok) router.refresh();
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setSaving(false);
    }
  }

  const incomplete = !form.servicesOffered.trim() || !form.senderName.trim();

  return (
    <>
      {message && (
        <div className={`banner ${message.kind}`}>
          <span>{message.text}</span>
        </div>
      )}

      {incomplete && (
        <div className="banner">
          ⚠️{' '}
          <span>
            <b>Fill these in before generating emails.</b> The AI writes about what you sell — with
            these blank, it has nothing concrete to work from and the copy will be generic.
          </span>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>Your offering</h3>
          <span className="hint">injected into every AI prompt</span>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="name">Company name</label>
          <input
            id="name"
            type="text"
            value={form.name}
            disabled={!canEdit}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="services">What you do</label>
          <textarea
            id="services"
            value={form.servicesOffered}
            rows={3}
            disabled={!canEdit}
            onChange={(e) => set('servicesOffered', e.target.value)}
            placeholder="Accounting and bookkeeping, accounts payable/receivable, payroll processing, data entry, customer support, and back-office administration."
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
            Be specific and concrete. &quot;Back-office administration&quot; produces better emails
            than &quot;business solutions&quot;.
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="value">Value proposition</label>
          <textarea
            id="value"
            value={form.valueProposition}
            rows={3}
            disabled={!canEdit}
            onChange={(e) => set('valueProposition', e.target.value)}
            placeholder="Trained offshore teams that handle finance and back-office operations at a fraction of local hiring cost."
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
            One or two sentences. What changes for the customer, not how great you are.
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="industries">Target industries</label>
          <input
            id="industries"
            type="text"
            value={form.targetIndustries}
            disabled={!canEdit}
            onChange={(e) => set('targetIndustries', e.target.value)}
            placeholder="Logistics, manufacturing, professional services, e-commerce"
          />
        </div>
      </div>

      <div className="card">
        <div className="ch">
          <h3>Sender identity</h3>
          <span className="hint">how emails are signed</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label htmlFor="senderName">Your name</label>
            <input
              id="senderName"
              type="text"
              value={form.senderName}
              disabled={!canEdit}
              onChange={(e) => set('senderName', e.target.value)}
              placeholder="Real name — not a team alias"
            />
          </div>
          <div>
            <label htmlFor="senderTitle">Your title</label>
            <input
              id="senderTitle"
              type="text"
              value={form.senderTitle}
              disabled={!canEdit}
              onChange={(e) => set('senderTitle', e.target.value)}
              placeholder="Director"
            />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="calendar">Booking link (optional)</label>
          <input
            id="calendar"
            type="url"
            value={form.calendarLink}
            disabled={!canEdit}
            onChange={(e) => set('calendarLink', e.target.value)}
            placeholder="https://cal.com/you/15min"
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
            Used only when a call is the natural ask. Leave blank and the AI will ask a question
            instead — which often performs better on a first email.
          </div>
        </div>

        {canEdit && (
          <div className="row">
            <button
              className="ctrl primary"
              onClick={() => void save()}
              disabled={saving || !isDirty || !form.name.trim()}
            >
              {saving ? <span className="spin" /> : 'Save'}
            </button>
            {isDirty && (
              <span className="muted" style={{ fontSize: 12 }}>
                Unsaved changes
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
