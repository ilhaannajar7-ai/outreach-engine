import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth, handleRoute } from '@/lib/api-helpers';
import { DEFAULT_THEME, normalizeTheme } from '@/lib/theme';

export const dynamic = 'force-dynamic';

/** The current user's saved theme (defaults if they have none yet). */
export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const [row] = await db
      .select({ prefs: users.themePreferences })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);
    return { theme: row?.prefs ? normalizeTheme(row.prefs) : DEFAULT_THEME };
  });
}

/** Save the current user's theme. The body is normalized before storage. */
export async function PUT(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const raw = await request.json().catch(() => ({}));
    const theme = normalizeTheme(raw);

    await db
      .update(users)
      .set({ themePreferences: theme, updatedAt: new Date() })
      .where(eq(users.id, ctx.userId));

    return { theme };
  });
}
