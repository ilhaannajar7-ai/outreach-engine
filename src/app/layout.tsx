import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getServerSession } from 'next-auth';
import { eq } from 'drizzle-orm';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { users } from '@/db/schema';
import { Providers } from '@/components/Providers';
import { Assistant } from '@/components/Assistant';
import {
  DEFAULT_THEME,
  normalizeTheme,
  themeCssVars,
  themeDataAttributes,
} from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Outreach Command Center',
  description: 'AI-powered outreach engine',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Load the signed-in user's saved theme and render it inline on <html>, so the
  // page paints in their colours immediately — no flash of the default theme.
  let theme = DEFAULT_THEME;
  try {
    const session = await getServerSession(authOptions);
    if (session?.user?.id) {
      const [row] = await db
        .select({ prefs: users.themePreferences })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);
      if (row?.prefs) theme = normalizeTheme(row.prefs);
    }
  } catch {
    // Never let a theme lookup break the whole app — fall back to defaults.
  }

  const cssVars = themeCssVars(theme) as React.CSSProperties;
  const dataAttrs = themeDataAttributes(theme);

  return (
    <html lang="en" style={cssVars} suppressHydrationWarning {...dataAttrs}>
      <body>
        <Providers>
          {children}
          {/* Global so it is reachable from every page; hides itself when
              nobody is signed in. */}
          <Assistant />
        </Providers>
      </body>
    </html>
  );
}
