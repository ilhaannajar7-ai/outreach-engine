/**
 * Dashboard aggregate queries.
 *
 * Kept out of the route handlers so the same numbers can be rendered by a
 * server component or returned as JSON without duplicating SQL.
 */

import { db } from '@/db';
import {
  leads,
  emails,
  replies,
  companies,
  contacts,
  sendingDomains,
  sendingInboxes,
  systemHealth,
  backgroundJobs,
} from '@/db/schema';
import { and, eq, gte, desc, sql as dsql } from 'drizzle-orm';
import { getBudgetStatus, getUsageByOperation } from '@/lib/ai/budget';
import { getRemainingCapacityToday } from '@/lib/sending/inbox-rotation';
import { ts } from '@/db/sql-helpers';

export interface DashboardKpis {
  totalLeads: number;
  emailsSent: number;
  replyRate: number;
  interested: number;
  meetingsBooked: number;
  followUpsDue: number;
  pendingApproval: number;
  requiresAttention: number;
}

export async function getKpis(organizationId: string, days = 14): Promise<DashboardKpis> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [leadCounts] = await db
    .select({
      total: dsql<number>`COUNT(*)::int`,
      interested: dsql<number>`COUNT(*) FILTER (WHERE ${leads.status} = 'interested')::int`,
      meetings: dsql<number>`COUNT(*) FILTER (WHERE ${leads.status} = 'meeting_booked')::int`,
      attention: dsql<number>`COUNT(*) FILTER (WHERE ${leads.requiresAttention} = true)::int`,
      followUpsDue: dsql<number>`COUNT(*) FILTER (WHERE ${leads.nextFollowUpAt} <= NOW())::int`,
    })
    .from(leads)
    .where(eq(leads.organizationId, organizationId));

  const [emailCounts] = await db
    .select({
      sent: dsql<number>`COUNT(*) FILTER (WHERE ${emails.sentAt} >= ${ts(since)})::int`,
      pending: dsql<number>`COUNT(*) FILTER (WHERE ${emails.status} = 'pending_approval')::int`,
    })
    .from(emails)
    .where(eq(emails.organizationId, organizationId));

  const [replyCount] = await db
    .select({ count: dsql<number>`COUNT(*)::int` })
    .from(replies)
    .where(and(eq(replies.organizationId, organizationId), gte(replies.receivedAt, since)));

  const sent = emailCounts?.sent ?? 0;
  const replyTotal = replyCount?.count ?? 0;

  return {
    totalLeads: leadCounts?.total ?? 0,
    emailsSent: sent,
    replyRate: sent > 0 ? (replyTotal / sent) * 100 : 0,
    interested: leadCounts?.interested ?? 0,
    meetingsBooked: leadCounts?.meetings ?? 0,
    followUpsDue: leadCounts?.followUpsDue ?? 0,
    pendingApproval: emailCounts?.pending ?? 0,
    requiresAttention: leadCounts?.attention ?? 0,
  };
}

/** Daily sent/reply series for the main chart. */
export async function getActivitySeries(
  organizationId: string,
  days = 14,
): Promise<{ date: string; sent: number; replies: number }[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const sentRows = await db
    .select({
      date: dsql<string>`TO_CHAR(DATE_TRUNC('day', ${emails.sentAt}), 'YYYY-MM-DD')`,
      count: dsql<number>`COUNT(*)::int`,
    })
    .from(emails)
    .where(and(eq(emails.organizationId, organizationId), gte(emails.sentAt, since)))
    .groupBy(dsql`DATE_TRUNC('day', ${emails.sentAt})`);

  const replyRows = await db
    .select({
      date: dsql<string>`TO_CHAR(DATE_TRUNC('day', ${replies.receivedAt}), 'YYYY-MM-DD')`,
      count: dsql<number>`COUNT(*)::int`,
    })
    .from(replies)
    .where(and(eq(replies.organizationId, organizationId), gte(replies.receivedAt, since)))
    .groupBy(dsql`DATE_TRUNC('day', ${replies.receivedAt})`);

  const sentMap = new Map(sentRows.map((r) => [r.date, r.count]));
  const replyMap = new Map(replyRows.map((r) => [r.date, r.count]));

  // Fill every day so the chart has no gaps.
  const series: { date: string; sent: number; replies: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    series.push({ date: key, sent: sentMap.get(key) ?? 0, replies: replyMap.get(key) ?? 0 });
  }

  return series;
}

export async function getFunnel(
  organizationId: string,
  days = 14,
): Promise<{ stage: string; count: number; percent: number }[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [row] = await db
    .select({
      sent: dsql<number>`COUNT(*) FILTER (WHERE ${emails.sentAt} >= ${ts(since)})::int`,
      delivered: dsql<number>`COUNT(*) FILTER (WHERE ${emails.status} IN ('delivered','sent') AND ${emails.sentAt} >= ${ts(since)})::int`,
      opened: dsql<number>`COUNT(*) FILTER (WHERE ${emails.openCount} > 0 AND ${emails.sentAt} >= ${ts(since)})::int`,
    })
    .from(emails)
    .where(eq(emails.organizationId, organizationId));

  const [replyRow] = await db
    .select({
      replied: dsql<number>`COUNT(*)::int`,
      interested: dsql<number>`COUNT(*) FILTER (WHERE ${replies.classification} = 'interested')::int`,
    })
    .from(replies)
    .where(and(eq(replies.organizationId, organizationId), gte(replies.receivedAt, since)));

  const sent = row?.sent ?? 0;
  const pct = (n: number) => (sent > 0 ? (n / sent) * 100 : 0);

  return [
    { stage: 'Sent', count: sent, percent: 100 },
    { stage: 'Delivered', count: row?.delivered ?? 0, percent: pct(row?.delivered ?? 0) },
    { stage: 'Opened', count: row?.opened ?? 0, percent: pct(row?.opened ?? 0) },
    { stage: 'Replied', count: replyRow?.replied ?? 0, percent: pct(replyRow?.replied ?? 0) },
    { stage: 'Interested', count: replyRow?.interested ?? 0, percent: pct(replyRow?.interested ?? 0) },
  ];
}

export async function getReplyBreakdown(
  organizationId: string,
  days = 14,
): Promise<{ classification: string; count: number }[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      classification: replies.classification,
      count: dsql<number>`COUNT(*)::int`,
    })
    .from(replies)
    .where(and(eq(replies.organizationId, organizationId), gte(replies.receivedAt, since)))
    .groupBy(replies.classification);

  return rows.map((r) => ({ classification: r.classification, count: r.count }));
}

/** The "leads requiring attention" table — the daily work list. */
export async function getLeadsRequiringAttention(organizationId: string, limit = 20) {
  return db
    .select({
      id: leads.id,
      status: leads.status,
      attentionReason: leads.attentionReason,
      updatedAt: leads.updatedAt,
      companyName: companies.name,
      contactName: contacts.fullName,
      contactEmail: contacts.email,
      contactTitle: contacts.jobTitle,
    })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .where(and(eq(leads.organizationId, organizationId), eq(leads.requiresAttention, true)))
    .orderBy(desc(leads.updatedAt))
    .limit(limit);
}

/** Sending infrastructure panel: domains with their inboxes and live counters. */
export async function getSendingInfrastructure(organizationId: string) {
  const domains = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.organizationId, organizationId))
    .orderBy(sendingDomains.createdAt);

  const inboxes = await db
    .select()
    .from(sendingInboxes)
    .where(eq(sendingInboxes.organizationId, organizationId))
    .orderBy(sendingInboxes.emailAddress);

  return domains.map((domain) => {
    const domainInboxes = inboxes.filter((i) => i.domainId === domain.id);
    const sentToday = domainInboxes.reduce((sum, i) => sum + i.sentToday, 0);

    const warmupProgress = domain.warmupCompleted
      ? 100
      : domain.warmupStartedAt
        ? Math.min(
            100,
            Math.round(
              ((Date.now() - domain.warmupStartedAt.getTime()) /
                (domain.warmupDurationDays * 24 * 60 * 60 * 1000)) *
                100,
            ),
          )
        : 0;

    const warmupWeek = domain.warmupStartedAt
      ? Math.floor(
          (Date.now() - domain.warmupStartedAt.getTime()) / (7 * 24 * 60 * 60 * 1000),
        ) + 1
      : 0;

    return {
      ...domain,
      inboxes: domainInboxes,
      inboxCount: domainInboxes.length,
      sentToday,
      warmupProgress,
      warmupWeek,
      warmupTotalWeeks: Math.ceil(domain.warmupDurationDays / 7),
    };
  });
}

export async function getSystemHealthRows() {
  return db.select().from(systemHealth).orderBy(systemHealth.component);
}

export async function getJobStats(organizationId: string) {
  const [row] = await db
    .select({
      pending: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'pending')::int`,
      running: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'running')::int`,
      dead: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'dead')::int`,
    })
    .from(backgroundJobs)
    .where(eq(backgroundJobs.organizationId, organizationId));

  return { pending: row?.pending ?? 0, running: row?.running ?? 0, dead: row?.dead ?? 0 };
}

/** Everything the dashboard page needs, in one call. */
export async function getDashboardData(organizationId: string, days = 14) {
  const [
    kpis,
    activity,
    funnel,
    replyBreakdown,
    attention,
    infrastructure,
    health,
    jobs,
    budget,
    aiByOperation,
    capacity,
  ] = await Promise.all([
    getKpis(organizationId, days),
    getActivitySeries(organizationId, days),
    getFunnel(organizationId, days),
    getReplyBreakdown(organizationId, days),
    getLeadsRequiringAttention(organizationId),
    getSendingInfrastructure(organizationId),
    getSystemHealthRows(),
    getJobStats(organizationId),
    getBudgetStatus(organizationId),
    getUsageByOperation(organizationId),
    getRemainingCapacityToday(organizationId),
  ]);

  return {
    kpis,
    activity,
    funnel,
    replyBreakdown,
    attention,
    infrastructure,
    health,
    jobs,
    budget,
    aiByOperation,
    capacity,
  };
}
