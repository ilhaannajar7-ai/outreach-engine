import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notifications';
import { getAnalyticsReport } from '@/lib/queries/analytics';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { ReportsPanel } from '@/components/ReportsPanel';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const params = await searchParams;
  const requested = Number(params.days);
  const days = [7, 30, 90].includes(requested) ? requested : 30;

  const [report, unreadCount] = await Promise.all([
    getAnalyticsReport(session.user.organizationId, days),
    getUnreadCount(session.user.organizationId),
  ]);

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <TopBar
          title="Reports"
          subtitle="How every part of the system is performing — and what it costs"
          unreadCount={unreadCount}
        />
        <div className="content">
          <Suspense fallback={<div className="spin" />}>
            <ReportsPanel report={report} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
