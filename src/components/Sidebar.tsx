'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  count?: number;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

export interface SidebarCounts {
  leads?: number;
  queue?: number;
  followUps?: number;
  replies?: number;
}

export function Sidebar({
  counts = {},
  health = 'operational',
}: {
  counts?: SidebarCounts;
  health?: 'operational' | 'degraded' | 'down';
}) {
  const pathname = usePathname();

  const groups: NavGroup[] = [
    {
      label: 'Overview',
      items: [
        { href: '/', label: 'Dashboard', icon: '▚' },
        { href: '/reports', label: 'Reports', icon: '▦' },
      ],
    },
    {
      label: 'Outreach',
      items: [
        { href: '/leads', label: 'Leads', icon: '◍', ...(counts.leads ? { count: counts.leads } : {}) },
        {
          href: '/queue',
          label: 'Approval queue',
          icon: '➤',
          ...(counts.queue ? { count: counts.queue } : {}),
        },
        { href: '/campaigns', label: 'Campaigns', icon: '◆' },
        { href: '/experiments', label: 'Strategy testing', icon: '⚖' },
      ],
    },
    {
      label: 'AI Engine',
      items: [
        { href: '/settings/ai', label: 'AI configuration', icon: '⚙' },
        { href: '/settings/prompts', label: 'Prompts', icon: '✎' },
      ],
    },
    {
      label: 'Sending',
      items: [
        { href: '/sending', label: 'Domains & inboxes', icon: '◈' },
        { href: '/sending/limits', label: 'Daily limits', icon: '⏱' },
      ],
    },
    {
      label: 'Monitoring',
      items: [
        { href: '/monitoring/health', label: 'System health', icon: '♥' },
        { href: '/monitoring/jobs', label: 'Background jobs', icon: '⚙' },
        { href: '/monitoring/audit', label: 'Audit log', icon: '◱' },
      ],
    },
    {
      label: 'Settings',
      items: [
        { href: '/settings/organization', label: 'Organization', icon: '▤' },
        { href: '/settings/appearance', label: 'Appearance', icon: '◐' },
        { href: '/settings/security', label: 'Security', icon: '🔒' },
        { href: '/settings/notifications', label: 'Notifications', icon: '🔔' },
      ],
    },
  ];

  const isActive = (href: string) => {
    const base = href.split('#')[0]!;
    if (base === '/') return pathname === '/';
    return pathname === base || pathname.startsWith(`${base}/`);
  };

  const healthLabel =
    health === 'operational'
      ? 'System operational'
      : health === 'degraded'
        ? 'Degraded — check health'
        : 'Component down';

  return (
    <aside className="sidebar">
      <div className="logo">
        <div className="mark">O</div>
        <div className="nm">
          Outreach
          <small>Command Center</small>
        </div>
      </div>

      {groups.map((group) => (
        <div className="navgrp" key={group.label}>
          <div className="gl">{group.label}</div>
          <div className="nav">
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={isActive(item.href) ? 'active' : ''}
              >
                <span className="ic" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
                {item.count !== undefined && item.count > 0 && (
                  <span className="cnt">{item.count > 999 ? '999+' : item.count}</span>
                )}
              </Link>
            ))}
          </div>
        </div>
      ))}

      <div className="sysstat">
        <span
          className={`dotpulse ${health === 'down' ? 'crit' : health === 'degraded' ? 'warn' : ''}`}
        />
        <span>{healthLabel}</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)' }}>
          v1.0
        </span>
      </div>
    </aside>
  );
}
