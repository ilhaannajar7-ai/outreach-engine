import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getNotifications, getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { NotificationList } from '@/components/NotificationList';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [items, unreadCount] = await Promise.all([
    getNotifications(orgId, { limit: 100 }),
    getUnreadCount(orgId),
  ]);

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Notifications"
          subtitle={`${unreadCount} unread of ${items.length}`}
          unreadCount={unreadCount}
        />

        <div className="content">
          <NotificationList
            notifications={items.map((n) => ({
              id: n.id,
              tier: n.tier,
              channel: n.channel,
              title: n.title,
              message: n.message,
              actionUrl: n.actionUrl,
              actionLabel: n.actionLabel,
              isRead: n.isRead,
              isResolved: n.isResolved,
              emailSent: n.emailSent,
              createdAt: n.createdAt.toISOString(),
            }))}
          />
        </div>
      </div>
    </div>
  );
}
