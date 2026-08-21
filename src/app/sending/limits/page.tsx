import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { settings, sendingInboxes, sendingDomains } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { env } from '@/lib/env';
import { getUnreadCount } from '@/lib/notifications';
import { getRemainingCapacityToday } from '@/lib/sending/inbox-rotation';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { LimitsForm } from '@/components/LimitsForm';

export const dynamic = 'force-dynamic';

export default async function LimitsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [rows, inboxes, capacity, unreadCount] = await Promise.all([
    db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.organizationId, orgId),
          inArray(settings.key, [
            'global_daily_send_limit',
            'require_email_verification',
            'auto_research_on_import',
          ]),
        ),
      ),
    db
      .select({
        id: sendingInboxes.id,
        emailAddress: sendingInboxes.emailAddress,
        status: sendingInboxes.status,
        sentToday: sendingInboxes.sentToday,
        dailySendLimit: sendingInboxes.dailySendLimit,
        maxDailySendLimit: sendingInboxes.maxDailySendLimit,
        warmupCompleted: sendingInboxes.warmupCompleted,
        domain: sendingDomains.domain,
      })
      .from(sendingInboxes)
      .innerJoin(sendingDomains, eq(sendingInboxes.domainId, sendingDomains.id))
      .where(eq(sendingInboxes.organizationId, orgId))
      .orderBy(sendingInboxes.emailAddress),
    getRemainingCapacityToday(orgId),
    getUnreadCount(orgId),
  ]);

  const map = new Map(rows.map((r) => [r.key, r.value]));

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Daily limits"
          subtitle={`${capacity.sentToday} sent today · ${capacity.remaining} remaining`}
          unreadCount={unreadCount}
        />

        <div className="content">
          <LimitsForm
            initial={{
              globalDailySendLimit: Number(
                map.get('global_daily_send_limit') ?? env.GLOBAL_DAILY_SEND_LIMIT,
              ),
              requireEmailVerification: map.get('require_email_verification') !== false,
              autoResearchOnImport: map.get('auto_research_on_import') === true,
            }}
            sendWindow={{
              startHour: env.SEND_WINDOW_START_HOUR,
              endHour: env.SEND_WINDOW_END_HOUR,
              timezone: env.SEND_TIMEZONE,
            }}
            capacity={capacity}
            inboxes={inboxes}
            canEdit={session.user.role === 'owner' || session.user.role === 'admin'}
          />
        </div>
      </div>
    </div>
  );
}
