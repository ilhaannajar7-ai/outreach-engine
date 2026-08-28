'use client';

import { useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { RefreshButton } from '@/components/RefreshButton';

export function TopBar({
  title,
  subtitle,
  unreadCount = 0,
  actions,
  refresh = true,
  refreshAutoSeconds,
}: {
  title: string;
  subtitle?: string;
  unreadCount?: number;
  actions?: React.ReactNode;
  /** Every data page gets a refresh control; set false for static pages. */
  refresh?: boolean;
  /** Offer background auto-refresh at this interval, for pages that move. */
  refreshAutoSeconds?: number;
}) {
  const { data: session } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  const initials = (session?.user?.name ?? session?.user?.email ?? 'U')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="sub">{subtitle}</div>}
      </div>

      <div className="spacer" />

      {actions}

      {refresh && <RefreshButton {...(refreshAutoSeconds ? { autoSeconds: refreshAutoSeconds } : {})} />}

      <Link href="/notifications" className="bell" aria-label={`Notifications (${unreadCount} unread)`}>
        🔔
        {unreadCount > 0 && <span className="bdg">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </Link>

      <div style={{ position: 'relative' }}>
        <button
          className="avatar"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Account menu"
          aria-expanded={menuOpen}
          style={{ border: 'none' }}
        >
          {initials}
        </button>

        {menuOpen && (
          <>
            {/* Click-away layer so the menu closes without a document listener. */}
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 40 }}
              onClick={() => setMenuOpen(false)}
            />
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 8px)',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow)',
                minWidth: 200,
                zIndex: 50,
                overflow: 'hidden',
              }}
            >
              <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 650 }}>{session?.user?.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{session?.user?.email}</div>
                <div
                  className="mono"
                  style={{ fontSize: 10, color: 'var(--faint)', marginTop: 3 }}
                >
                  {session?.user?.organizationName} · {session?.user?.role}
                </div>
              </div>
              <button
                onClick={() => void signOut({ callbackUrl: '/login' })}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '9px 12px',
                  background: 'none',
                  border: 'none',
                  color: 'var(--crit)',
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
