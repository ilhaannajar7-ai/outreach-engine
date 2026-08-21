import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSendingInfrastructure } from '@/lib/queries/dashboard';
import { getRemainingCapacityToday } from '@/lib/sending/inbox-rotation';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { DomainPanel } from '@/components/DomainPanel';

export const dynamic = 'force-dynamic';

export default async function SendingPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [infrastructure, capacity, unreadCount] = await Promise.all([
    getSendingInfrastructure(orgId),
    getRemainingCapacityToday(orgId),
    getUnreadCount(orgId),
  ]);

  const totalInboxes = infrastructure.reduce((sum, d) => sum + d.inboxCount, 0);

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Domains &amp; inboxes"
          subtitle={`${infrastructure.length} domain${infrastructure.length === 1 ? '' : 's'} · ${totalInboxes} inbox${totalInboxes === 1 ? '' : 'es'} · ${capacity.remaining} sends left today`}
          unreadCount={unreadCount}
        />

        <div className="content">
          {infrastructure.length === 0 && (
            <div className="banner">
              ℹ️{' '}
              <span>
                <b>No sending domains yet.</b> Add one below. You&apos;ll need SPF, DKIM, and DMARC
                records in DNS before it can send — the system checks them for you.
              </span>
            </div>
          )}

          <DomainPanel domains={infrastructure} />

          <div className="card">
            <div className="ch">
              <h3>How scaling works</h3>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.75, color: 'var(--muted)' }}>
              <p style={{ marginTop: 0 }}>
                <b style={{ color: 'var(--ink)' }}>Warm-up is not optional.</b> Every new inbox
                starts at 10 emails/day and roughly doubles each week for about six weeks. Inbox
                providers score senders on consistency, and ramping faster is the most common way to
                burn a domain. The schedule advances automatically — you never have to touch it.
              </p>
              <p>
                <b style={{ color: 'var(--ink)' }}>Sends spread across every active inbox.</b> The
                one with the most remaining headroom goes next, so volume stays even. Adding an
                inbox raises capacity immediately; adding a domain isolates reputation so a problem
                on one domain cannot affect the others.
              </p>
              <p style={{ marginBottom: 0 }}>
                <b style={{ color: 'var(--ink)' }}>Bad inboxes pause themselves.</b> Reputation is
                recalculated nightly from bounce and complaint rates. An inbox that crosses the
                threshold pauses and alerts you rather than continuing to damage the domain.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
