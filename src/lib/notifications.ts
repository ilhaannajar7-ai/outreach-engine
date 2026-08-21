/**
 * Three-tier notification system.
 *
 *   Tier 1 — auto-fixed        : logged, no interruption. The system healed itself.
 *   Tier 2 — auto + notify     : handled automatically, but you should know.
 *   Tier 3 — stopped, waiting  : needs a human. Dashboard alert AND email, now.
 *
 * The tier decides the channel, so callers never have to remember which alerts
 * are worth an email — they state severity and the routing follows.
 */

import { db } from '@/db';
import { notifications, organizations, type NotificationTier } from '@/db/schema';
import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { getEmailService } from '@/lib/providers/email';

export interface NotifyParams {
  organizationId: string;
  tier: NotificationTier;
  title: string;
  message: string;
  /** Deep link so the alert is one click from its fix. */
  actionUrl?: string;
  actionLabel?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  metadata?: Record<string, unknown>;
}

const TIER_CHANNEL: Record<NotificationTier, 'dashboard' | 'email' | 'both'> = {
  tier_1_auto_fixed: 'dashboard',
  tier_2_auto_notified: 'dashboard',
  tier_3_stopped: 'both',
  info: 'dashboard',
};

export async function notify(params: NotifyParams): Promise<string> {
  const channel = TIER_CHANNEL[params.tier];

  const [row] = await db
    .insert(notifications)
    .values({
      organizationId: params.organizationId,
      tier: params.tier,
      channel,
      title: params.title.slice(0, 255),
      message: params.message,
      actionUrl: params.actionUrl ?? null,
      actionLabel: params.actionLabel ?? null,
      relatedEntityType: params.relatedEntityType ?? null,
      relatedEntityId: params.relatedEntityId ?? null,
      metadata: params.metadata ?? null,
    })
    .returning({ id: notifications.id });

  const id = row!.id;

  // Email delivery must never fail the operation that raised the alert.
  if (channel === 'both' || channel === 'email') {
    sendNotificationEmail(id, params).catch((error) => {
      console.error(`[notifications] failed to email alert ${id}:`, error);
    });
  }

  return id;
}

async function sendNotificationEmail(notificationId: string, params: NotifyParams): Promise<void> {
  const to = env.ALERT_EMAIL_TO;
  const from = env.ALERT_EMAIL_FROM;
  if (!to || !from) return;

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);

  const actionLine = params.actionUrl
    ? `\n\n${params.actionLabel ?? 'Open dashboard'}: ${env.APP_URL}${params.actionUrl}`
    : `\n\nDashboard: ${env.APP_URL}`;

  const body =
    `${params.message}${actionLine}\n\n` +
    `— Outreach Engine${org?.name ? ` · ${org.name}` : ''}\n` +
    `This alert was sent because it requires your attention before the system can continue.`;

  await getEmailService().send({
    from,
    fromName: 'Outreach Engine',
    to,
    subject: `[Action needed] ${params.title}`,
    text: body,
  });

  await db
    .update(notifications)
    .set({ emailSent: true, emailSentAt: new Date() })
    .where(eq(notifications.id, notificationId));
}

/** Tier 1 — something broke and the system fixed it. Recorded, not escalated. */
export function notifyAutoFixed(
  organizationId: string,
  title: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  return notify({
    organizationId,
    tier: 'tier_1_auto_fixed',
    title,
    message,
    ...(metadata ? { metadata } : {}),
  });
}

/** Tier 2 — handled automatically, but worth knowing about. */
export function notifyHandled(
  organizationId: string,
  title: string,
  message: string,
  options?: { actionUrl?: string; actionLabel?: string; metadata?: Record<string, unknown> },
): Promise<string> {
  return notify({
    organizationId,
    tier: 'tier_2_auto_notified',
    title,
    message,
    ...(options?.actionUrl ? { actionUrl: options.actionUrl } : {}),
    ...(options?.actionLabel ? { actionLabel: options.actionLabel } : {}),
    ...(options?.metadata ? { metadata: options.metadata } : {}),
  });
}

/** Tier 3 — work has stopped and will not resume without a human. */
export function notifyStopped(
  organizationId: string,
  title: string,
  message: string,
  options?: { actionUrl?: string; actionLabel?: string; metadata?: Record<string, unknown> },
): Promise<string> {
  return notify({
    organizationId,
    tier: 'tier_3_stopped',
    title,
    message,
    ...(options?.actionUrl ? { actionUrl: options.actionUrl } : {}),
    ...(options?.actionLabel ? { actionLabel: options.actionLabel } : {}),
    ...(options?.metadata ? { metadata: options.metadata } : {}),
  });
}

export async function getNotifications(
  organizationId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
) {
  const conditions = [eq(notifications.organizationId, organizationId)];
  if (options.unreadOnly) conditions.push(eq(notifications.isRead, false));

  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(options.limit ?? 50);
}

export async function getUnreadCount(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: dsql<number>`COUNT(*)::int` })
    .from(notifications)
    .where(
      and(eq(notifications.organizationId, organizationId), eq(notifications.isRead, false)),
    );
  return row?.count ?? 0;
}

export async function markAsRead(notificationId: string, organizationId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(
      and(eq(notifications.id, notificationId), eq(notifications.organizationId, organizationId)),
    );
}

export async function markAllAsRead(organizationId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(
      and(eq(notifications.organizationId, organizationId), eq(notifications.isRead, false)),
    );
}

export async function resolveNotification(
  notificationId: string,
  organizationId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ isResolved: true, resolvedAt: new Date(), isRead: true, readAt: new Date() })
    .where(
      and(eq(notifications.id, notificationId), eq(notifications.organizationId, organizationId)),
    );
}
