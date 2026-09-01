import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { InsightsPanel } from '@/components/InsightsPanel';

export const dynamic = 'force-dynamic';

export default async function InsightsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const unreadCount = await getUnreadCount(session.user.organizationId);

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <TopBar
          title="Insights"
          subtitle="Weekly analysis of what is working, and which approach wins"
          unreadCount={unreadCount}
        />
        <div className="content">
          <InsightsPanel canEdit={session.user.role !== 'viewer'} />
        </div>
      </div>
    </div>
  );
}
