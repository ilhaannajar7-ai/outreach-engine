import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { notifications, type NotificationTier } from '@/db/schema';
import { eq, sql as dsql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const TIERS: {
  id: NotificationTier;
  icon: string;
  title: string;
  channels: string;
  color: string;
  soft: string;
  description: string;
  examples: string[];
}[] = [
  {
    id: 'tier_3_stopped',
    icon: '⛔',
    title: 'Tier 3 — Stopped, needs you',
    channels: 'Dashboard + email, immediately',
    color: 'var(--crit)',
    soft: 'var(--crit-soft)',
    description:
      'Work has stopped and will not resume without a decision from you. These are the only alerts that email you.',
    examples: [
      'A prospect replied with interest',
      'The monthly AI budget is exhausted',
      'An API key is invalid or rejected',
      'An inbox was paused for poor reputation',
      'An email failed to send after all retries',
    ],
  },
  {
    id: 'tier_2_auto_notified',
    icon: '!',
    title: 'Tier 2 — Handled, for your information',
    channels: 'Dashboard only',
    color: 'var(--warn)',
    soft: 'var(--warn-soft)',
    description:
      'The system dealt with it correctly, but you should know it happened. No action required.',
    examples: [
      'The daily send limit was reached',
      'An unsubscribe request was honoured',
      'A reply needs human review',
      'A contact turned out to be the wrong person',
    ],
  },
  {
    id: 'tier_1_auto_fixed',
    icon: '✓',
    title: 'Tier 1 — Fixed automatically',
    channels: 'Dashboard only',
    color: 'var(--good)',
    soft: 'var(--good-soft)',
    description:
      'Something broke and the system repaired it without help. Recorded so you can see it happened, never escalated.',
    examples: [
      'A stalled job was reclaimed and re-queued',
      'An interrupted send was recovered',
      'Warm-up limits were raised on schedule',
    ],
  },
];

export default async function NotificationSettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [counts, unreadCount] = await Promise.all([
    db
      .select({
        tier: notifications.tier,
        total: dsql<number>`COUNT(*)::int`,
        emailed: dsql<number>`COUNT(*) FILTER (WHERE ${notifications.emailSent} = true)::int`,
      })
      .from(notifications)
      .where(eq(notifications.organizationId, orgId))
      .groupBy(notifications.tier),
    getUnreadCount(orgId),
  ]);

  const countMap = new Map(counts.map((c) => [c.tier, c]));
  const emailConfigured = Boolean(env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM);

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Notifications"
          subtitle="What the system tells you, and how"
          unreadCount={unreadCount}
        />

        <div className="content">
          {!emailConfigured ? (
            <div className="banner crit">
              ⛔{' '}
              <span>
                <b>Email alerts are not configured.</b> Tier-3 alerts — including a prospect replying
                with interest — will only appear on the dashboard. Set{' '}
                <code className="mono">ALERT_EMAIL_TO</code> and{' '}
                <code className="mono">ALERT_EMAIL_FROM</code> in <code className="mono">.env</code>{' '}
                and restart.
              </span>
            </div>
          ) : (
            <div className="banner good">
              ✓{' '}
              <span>
                Tier-3 alerts are emailed to <b className="mono">{env.ALERT_EMAIL_TO}</b>.
              </span>
            </div>
          )}

          <div className="card">
            <div className="ch">
              <h3>How alerting works</h3>
              <Link href="/notifications" className="ctrl sm">
                View notifications →
              </Link>
            </div>

            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.7 }}>
              Severity determines the channel, so nothing important gets lost in a stream of routine
              messages. Only Tier 3 interrupts you.
            </div>

            <div className="stack">
              {TIERS.map((tier) => {
                const stats = countMap.get(tier.id);

                return (
                  <div
                    key={tier.id}
                    style={{
                      border: '1px solid var(--line)',
                      borderLeft: `3px solid ${tier.color}`,
                      borderRadius: 10,
                      padding: 14,
                      background: 'var(--panel-2)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: 7,
                          background: tier.soft,
                          color: tier.color,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 13,
                          flex: 'none',
                        }}
                      >
                        {tier.icon}
                      </span>
                      <b style={{ fontSize: 13.5 }}>{tier.title}</b>
                      <span className="pill neutral">{tier.channels}</span>
                      <span
                        className="mono muted"
                        style={{ marginLeft: 'auto', fontSize: 11 }}
                      >
                        {stats?.total ?? 0} sent
                        {stats && stats.emailed > 0 && ` · ${stats.emailed} emailed`}
                      </span>
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                      {tier.description}
                    </div>

                    <ul
                      style={{
                        margin: '10px 0 0',
                        paddingLeft: 18,
                        fontSize: 11.5,
                        color: 'var(--muted)',
                        lineHeight: 1.7,
                      }}
                    >
                      {tier.examples.map((example) => (
                        <li key={example}>{example}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="ch">
              <h3>What the system will never do</h3>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.75, color: 'var(--muted)' }}>
              <p style={{ marginTop: 0 }}>
                <b style={{ color: 'var(--ink)' }}>Never reply on your behalf.</b> The AI classifies
                incoming replies and routes them. Every response to a real person is written by you.
              </p>
              <p>
                <b style={{ color: 'var(--ink)' }}>Never send without approval.</b> Drafts wait in
                the approval queue indefinitely. There is no auto-send path in the code.
              </p>
              <p style={{ marginBottom: 0 }}>
                <b style={{ color: 'var(--ink)' }}>Never work around a block.</b> If a provider
                rejects the account or an inbox is flagged, the system stops and tells you. It does
                not rotate to another identity to keep sending.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
