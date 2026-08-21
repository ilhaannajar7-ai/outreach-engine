import { redirect, notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import Link from 'next/link';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { leads, companies, contacts, emails, replies, aiResearch, campaigns } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { LeadActions } from '@/components/LeadActions';
import { formatStatus, statusPill, formatRelativeTime } from '@/lib/format';
import { normalizeHooks, HOOK_QUALITY_THRESHOLD } from '@/lib/ai/hook-quality';

export const dynamic = 'force-dynamic';

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;
  const { id } = await params;

  const [row] = await db
    .select({
      lead: leads,
      company: companies,
      contact: contacts,
      research: aiResearch,
      campaign: campaigns,
    })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(aiResearch, eq(leads.researchId, aiResearch.id))
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .where(and(eq(leads.id, id), eq(leads.organizationId, orgId)))
    .limit(1);

  if (!row) notFound();

  const [leadEmails, leadReplies, unreadCount] = await Promise.all([
    db.select().from(emails).where(eq(emails.leadId, id)).orderBy(emails.createdAt),
    db.select().from(replies).where(eq(replies.leadId, id)).orderBy(desc(replies.receivedAt)),
    getUnreadCount(orgId),
  ]);

  const { lead, company, contact, research } = row;

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title={company.name}
          subtitle={`${contact.fullName ?? contact.email}${contact.jobTitle ? ` · ${contact.jobTitle}` : ''}`}
          unreadCount={unreadCount}
        />

        <div className="content">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Link href="/leads" className="ctrl sm ghost">
              ← All leads
            </Link>
            <span className={`pill ${statusPill(lead.status)}`}>{formatStatus(lead.status)}</span>
            {contact.isUnsubscribed && <span className="pill crit">Unsubscribed</span>}
            {contact.isSuppressed && !contact.isUnsubscribed && (
              <span className="pill crit">Suppressed</span>
            )}
            {contact.emailVerified ? (
              <span className="pill good">Email verified</span>
            ) : (
              <span className="pill neutral">Unverified</span>
            )}
          </div>

          {lead.requiresAttention && lead.attentionReason && (
            <div className="banner">
              ⚠️{' '}
              <span>
                <b>Needs you:</b> {lead.attentionReason}
              </span>
            </div>
          )}

          {lead.lastError && (
            <div className="banner crit">
              ⛔{' '}
              <span>
                <b>Last error:</b> {lead.lastError}
              </span>
            </div>
          )}

          <LeadActions
            leadId={lead.id}
            hasResearch={Boolean(lead.researchId)}
            status={lead.status}
            isSuppressed={contact.isUnsubscribed || contact.isSuppressed}
          />

          <div className="grid2">
            {/* --- Company & contact ---------------------------------------- */}
            <div className="card">
              <div className="ch">
                <h3>Company &amp; contact</h3>
              </div>
              <DetailRow label="Company" value={company.name} />
              <DetailRow label="Domain" value={company.domain ?? '—'} mono />
              <DetailRow label="Industry" value={company.industry ?? '—'} />
              <DetailRow label="Size" value={company.sizeRange ?? '—'} />
              <DetailRow label="Location" value={company.location ?? '—'} />
              <DetailRow label="Contact" value={contact.fullName ?? '—'} />
              <DetailRow label="Title" value={contact.jobTitle ?? '—'} />
              <DetailRow label="Email" value={contact.email} mono />
              {company.hiringSignal && (
                <div style={{ marginTop: 12 }}>
                  <div className="seclabel">Hiring signal</div>
                  <div style={{ fontSize: 12.5 }}>{company.hiringSignal}</div>
                  {company.hiringSignalUrl && (
                    <a
                      href={company.hiringSignalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="act"
                      style={{ display: 'inline-block', marginTop: 5 }}
                    >
                      View source ↗
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* --- Research ------------------------------------------------- */}
            <div className="card">
              <div className="ch">
                <h3>AI research</h3>
                {research && (
                  <span className="hint">
                    {research.model} · ${Number(research.costUsd).toFixed(4)}
                  </span>
                )}
              </div>

              {!research ? (
                <div className="empty">
                  No research yet. Run it above — the email quality depends on it.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12.5, lineHeight: 1.65, marginBottom: 12 }}>
                    {research.summary}
                  </div>

                  {research.painPoints && research.painPoints.length > 0 && (
                    <ResearchList title="Likely pain points" items={research.painPoints} />
                  )}
                  {research.opportunities && research.opportunities.length > 0 && (
                    <ResearchList title="Opportunities" items={research.opportunities} />
                  )}
                  {(() => {
                    const hooks = normalizeHooks(research.personalizationHooks);
                    if (hooks.length === 0) return null;

                    return (
                      <div style={{ marginTop: 14 }}>
                        <div className="seclabel">
                          Hooks — the email is built on the strongest one
                        </div>

                        <div className="stack" style={{ gap: 8 }}>
                          {hooks.map((hook, index) => (
                            <div
                              key={`${hook.observation}-${index}`}
                              style={{
                                border: '1px solid var(--line)',
                                borderLeft: `3px solid ${
                                  hook.score >= HOOK_QUALITY_THRESHOLD
                                    ? 'var(--good)'
                                    : 'var(--warn)'
                                }`,
                                borderRadius: 8,
                                padding: '9px 11px',
                                background: 'var(--panel-2)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  marginBottom: 4,
                                }}
                              >
                                {index === 0 && hook.score >= HOOK_QUALITY_THRESHOLD && (
                                  <span className="pill good">Building on this</span>
                                )}
                                <span
                                  className="pill neutral mono"
                                  style={{ marginLeft: 'auto' }}
                                  title="Specificity score — could this sentence be true of another company?"
                                >
                                  {hook.score}/100
                                </span>
                              </div>

                              <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                                {hook.observation}
                              </div>

                              {hook.inference && (
                                <div
                                  style={{
                                    fontSize: 12,
                                    lineHeight: 1.6,
                                    color: 'var(--muted)',
                                    marginTop: 4,
                                    paddingLeft: 12,
                                    borderLeft: '2px solid var(--line)',
                                  }}
                                >
                                  → {hook.inference}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  <div
                    className="muted"
                    style={{ fontSize: 11, marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}
                  >
                    <span>Researched {formatRelativeTime(research.createdAt)}</span>
                    {research.fitScore !== null && (
                      <span>
                        Fit{' '}
                        <b
                          style={{
                            color:
                              research.fitScore >= 60 ? 'var(--good)' : 'var(--warn)',
                          }}
                        >
                          {research.fitScore}/100
                        </b>
                      </span>
                    )}
                  </div>

                  {research.disqualifiers && research.disqualifiers.length > 0 && (
                    <div className="banner" style={{ marginTop: 10 }}>
                      ⚠️{' '}
                      <span>
                        <b>Reasons not to pursue:</b> {research.disqualifiers.join(' · ')}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* --- Replies ---------------------------------------------------- */}
          {leadReplies.length > 0 && (
            <div className="card">
              <div className="ch">
                <h3>Replies</h3>
                <span className="hint">{leadReplies.length}</span>
              </div>
              <div className="stack">
                {leadReplies.map((reply) => (
                  <div
                    key={reply.id}
                    style={{
                      border: '1px solid var(--line)',
                      borderLeft: '3px solid var(--violet)',
                      borderRadius: 9,
                      padding: 13,
                      background: 'var(--panel-2)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
                      <span className={`pill ${replyPill(reply.classification)}`}>
                        {formatStatus(reply.classification)}
                      </span>
                      {reply.classificationConfidence && (
                        <span className="mono muted" style={{ fontSize: 10.5 }}>
                          {(Number(reply.classificationConfidence) * 100).toFixed(0)}% confident
                        </span>
                      )}
                      <span className="muted mono" style={{ fontSize: 10.5, marginLeft: 'auto' }}>
                        {formatRelativeTime(reply.receivedAt)}
                      </span>
                    </div>

                    {reply.summary && (
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
                        {reply.summary}
                      </div>
                    )}

                    <div
                      style={{
                        fontSize: 12.5,
                        lineHeight: 1.6,
                        whiteSpace: 'pre-wrap',
                        color: 'var(--muted)',
                        maxHeight: 200,
                        overflowY: 'auto',
                      }}
                    >
                      {reply.bodyText}
                    </div>

                    <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                      Reply to this from your own inbox — the system never answers on your behalf.
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* --- Email history ---------------------------------------------- */}
          <div className="card">
            <div className="ch">
              <h3>Email history</h3>
              <span className="hint">{leadEmails.length} message{leadEmails.length === 1 ? '' : 's'}</span>
            </div>

            {leadEmails.length === 0 ? (
              <div className="empty">No emails generated yet.</div>
            ) : (
              <div className="stack">
                {leadEmails.map((email) => (
                  <div
                    key={email.id}
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: 9,
                      padding: 13,
                      background: 'var(--panel-2)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                      <span className="pill neutral">{formatStatus(email.kind)}</span>
                      <span className={`pill ${emailPill(email.status)}`}>
                        {formatStatus(email.status)}
                      </span>
                      {email.wasEditedByHuman && <span className="pill rev">Edited by you</span>}
                      <span className="muted mono" style={{ fontSize: 10.5, marginLeft: 'auto' }}>
                        {email.sentAt
                          ? `sent ${formatRelativeTime(email.sentAt)}`
                          : `created ${formatRelativeTime(email.createdAt)}`}
                      </span>
                    </div>

                    <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 6 }}>{email.subject}</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                      {email.bodyText}
                    </div>

                    {email.failureReason && (
                      <div
                        className="banner crit"
                        style={{ marginTop: 10, fontSize: 11.5, padding: '7px 11px' }}
                      >
                        <span>{email.failureReason}</span>
                      </div>
                    )}

                    <div
                      className="muted mono"
                      style={{ fontSize: 10, marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap' }}
                    >
                      {email.fromAddress && <span>from {email.fromAddress}</span>}
                      <span>to {email.toAddress}</span>
                      {email.openCount > 0 && <span>{email.openCount} opens</span>}
                      {email.model && <span>{email.model}</span>}
                      {email.costUsd && <span>${Number(email.costUsd).toFixed(4)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '6px 0',
        borderBottom: '1px solid var(--line)',
        fontSize: 12.5,
      }}
    >
      <span className="muted" style={{ minWidth: 90 }}>
        {label}
      </span>
      <span className={mono ? 'mono' : ''} style={{ fontWeight: 500 }}>
        {value}
      </span>
    </div>
  );
}

function ResearchList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="seclabel">{title}</div>
      <ul style={{ margin: 0, paddingLeft: 17, fontSize: 12.5, lineHeight: 1.6 }}>
        {items.map((item, index) => (
          <li key={index} style={{ marginBottom: 3 }}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function replyPill(classification: string): string {
  if (classification === 'interested') return 'int';
  if (classification === 'maybe') return 'rev';
  if (classification === 'not_interested' || classification === 'unsubscribe_request') return 'crit';
  return 'neutral';
}

function emailPill(status: string): string {
  if (status === 'sent' || status === 'delivered') return 'good';
  if (status === 'pending_approval') return 'rev';
  if (status === 'approved' || status === 'queued') return 'fu';
  if (status === 'bounced' || status === 'failed' || status === 'rejected' || status === 'complained')
    return 'crit';
  return 'neutral';
}
