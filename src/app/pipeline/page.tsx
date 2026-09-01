import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { PipelinePanel } from '@/components/PipelinePanel';

export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const unreadCount = await getUnreadCount(session.user.organizationId);

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <TopBar
          title="Pipeline"
          subtitle="Every lead in flight — why it was targeted, where it is, what happens next"
          unreadCount={unreadCount}
          refresh={false}
        />
        <div className="content">
          <PipelinePanel />
        </div>
      </div>
    </div>
  );
}
