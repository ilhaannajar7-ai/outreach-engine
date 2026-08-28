import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { SourcingPanel } from '@/components/SourcingPanel';
import { canAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function SourcingSettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const unreadCount = await getUnreadCount(session.user.organizationId);

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <TopBar
          title="Lead sourcing"
          subtitle="Find companies automatically with Apollo"
          unreadCount={unreadCount}
        />
        <div className="content">
          <SourcingPanel canEdit={canAdmin(session.user.role)} />
        </div>
      </div>
    </div>
  );
}
