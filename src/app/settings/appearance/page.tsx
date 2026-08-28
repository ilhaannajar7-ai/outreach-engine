import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { eq } from 'drizzle-orm';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { users } from '@/db/schema';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { ThemeCustomizer } from '@/components/ThemeCustomizer';
import { DEFAULT_THEME, normalizeTheme } from '@/lib/theme';

export const dynamic = 'force-dynamic';

export default async function AppearancePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const [row] = await db
    .select({ prefs: users.themePreferences })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  const theme = row?.prefs ? normalizeTheme(row.prefs) : DEFAULT_THEME;
  const unreadCount = await getUnreadCount(session.user.organizationId);

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <TopBar
          title="Appearance"
          subtitle="Personalize your theme — only you see these changes"
          unreadCount={unreadCount}
        />
        <div className="content">
          <ThemeCustomizer initial={theme} />
        </div>
      </div>
    </div>
  );
}
