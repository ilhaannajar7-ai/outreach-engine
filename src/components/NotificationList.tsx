'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatRelativeTime } from '@/lib/format';

interface NotificationItem {
  id: string;
  tier: string;
  channel: string;
  title: string;
  message: string;
  actionUrl: string | null;
  actionLabel: string | null;
  isRead: boolean;
  isResolved: boolean;
  emailSent: boolean;
  createdAt: string;
}

/** Tier decides both the visual weight and whether an email was sent. */
const TIER_META: Record<string, { icon: string; label: string; color: string; soft: string }> = {
  tier_3_stopped: {
    icon: '⛔',
    label: 'Stopped — needs you',
    color: 'var(--crit)',
    soft: 'var(--crit-soft)',
  },
  tier_2_auto_notified: {
    icon: '!',
    label: 'Handled — for your information',
    color: 'var(--warn)',
    soft: 'var(--warn-soft)',
  },
  tier_1_auto_fixed: {
    icon: '✓',
    label: 'Fixed automatically',
    color: 'var(--good)',
    soft: 'var(--good-soft)',
  },
  info: { icon: 'ℹ', label: 'Information', color: 'var(--blue)', soft: 'var(--blue-soft)' },
};

export function NotificationList({ notifications }: { notifications: NotificationItem[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<'all' | 'unread' | 'tier_3_stopped'>('all');
  const [busy, setBusy] = useState(false);

  const visible = notifications.filter((n) => {
    if (filter === 'unread') return !n.isRead;
    if (filter === 'tier_3_stopped') return n.tier === 'tier_3_stopped';
    return true;
  });

  async function act(action: 'read' | 'read_all' | 'resolve', id?: string) {
    setBusy(true);
    try {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(id ? { id } : {}) }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="ch">
        <h3>Notifications</h3>
        <span className="hint">{visible.length} shown</span>
        <button className="ctrl sm" onClick={() => void act('read_all')} disabled={busy}>
          Mark all read
        </button>
      </div>

      <div className="row" style={{ marginBottom: 12, gap: 6 }}>
        {(
          [
            ['all', 'All'],
            ['unread', 'Unread'],
            ['tier_3_stopped', 'Needs you'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={`ctrl sm ${filter === value ? 'primary' : ''}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="empty">Nothing here.</div>
      ) : (
        <div className="stack">
          {visible.map((notification) => {
            const meta = TIER_META[notification.tier] ?? TIER_META.info!;

            return (
              <div
                key={notification.id}
                style={{
                  display: 'flex',
                  gap: 11,
                  padding: 13,
                  border: '1px solid var(--line)',
                  borderLeft: `3px solid ${meta.color}`,
                  borderRadius: 9,
                  background: notification.isRead ? 'transparent' : 'var(--panel-2)',
                  opacity: notification.isResolved ? 0.6 : 1,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: meta.soft,
                    color: meta.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    flex: 'none',
                  }}
                >
                  {meta.icon}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 13 }}>{notification.title}</div>
                  <div
                    style={{
                      color: 'var(--muted)',
                      fontSize: 12,
                      marginTop: 3,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {notification.message}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {notification.actionUrl && (
                      <Link href={notification.actionUrl} className="act">
                        {notification.actionLabel ?? 'Open'} →
                      </Link>
                    )}
                    <span
                      className="mono"
                      style={{ fontSize: 9, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}
                    >
                      {meta.label}
                    </span>
                    {notification.emailSent && (
                      <span className="pill neutral" style={{ fontSize: 9 }}>
                        emailed
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>
                    {formatRelativeTime(notification.createdAt)}
                  </div>
                  {!notification.isResolved && (
                    <button
                      className="ctrl sm ghost"
                      style={{ marginTop: 6 }}
                      onClick={() => void act('resolve', notification.id)}
                      disabled={busy}
                    >
                      Resolve
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
