import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { TwoFactorPanel } from '@/components/TwoFactorPanel';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const [rows, unreadCount] = await Promise.all([
    db
      .select({
        twoFactorEnabledAt: users.twoFactorEnabledAt,
        twoFactorRecoveryCodes: users.twoFactorRecoveryCodes,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1),
    getUnreadCount(session.user.organizationId),
  ]);

  const me = rows[0];

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <TopBar
          title="Security"
          subtitle="Protect your account and everyone it can send mail as"
          unreadCount={unreadCount}
        />
        <div className="content">
          <TwoFactorPanel
            enabled={Boolean(me?.twoFactorEnabledAt)}
            recoveryCodesRemaining={me?.twoFactorRecoveryCodes?.length ?? 0}
          />
        </div>
      </div>
    </div>
  );
}
