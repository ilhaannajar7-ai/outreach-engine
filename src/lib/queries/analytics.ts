/**
 * Cross-system performance report.
 *
 * Answers "is this thing working, and what is it costing me" in one query pass:
 * the email funnel, per-inbox warm-up and reputation, AI spend by operation,
 * third-party API consumption, and what the database actually holds.
 *
 * Two honesty notes that the UI repeats to the reader:
 *   - Open rate depends on tracking pixels, which many clients block. Treat it
 *     as a floor, not a measurement, and never rank variants on it alone.
 *   - Inbox-vs-spam placement is not observable from the sending side by any
 *     provider. Reply rate is the honest proxy.
 */

import { db } from '@/db';
import {
  emails,
  emailEvents,
  replies,
  leads,
  companies,
  contacts,
  aiUsage,
  apiUsage,
  sendingInboxes,
  sendingDomains,
} from '@/db/schema';
import { and, eq, gte, sql as dsql } from 'drizzle-orm';

export interface FunnelStats {
  approved: number;
  sent: number;
  delivered: number;
  opened: number;
  bounced: number;
  complained: number;
  replied: number;
  interested: number;
  deliveryRate: number;
  openRate: number;
  replyRate: number;
  interestedRate: number;
  bounceRate: number;
  complaintRate: number;
}

export interface InboxHealth {
  emailAddress: string;
  domain: string;
  status: string;
  provider: string;
  reputationScore: number;
  dailyLimit: number;
  maxDailyLimit: number;
  sentToday: number;
  totalSent: number;
  totalBounced: number;
  bounceRate: number;
  warmupDay: number | null;
  warmupCompleted: boolean;
}

export interface AiSpendRow {
  operation: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ApiUsageRow {
  provider: string;
  calls: number;
  credits: number;
  failures: number;
}

export interface DatabaseCounts {
  companies: number;
  contacts: number;
  leads: number;
  emails: number;
  replies: number;
  sourcedCompanies: number;
}

export interface AnalyticsReport {
  periodDays: number;
  since: Date;
  funnel: FunnelStats;
  inboxes: InboxHealth[];
  aiSpend: AiSpendRow[];
  aiTotalCost: number;
  apiUsage: ApiUsageRow[];
  database: DatabaseCounts;
  dailySends: { day: string; sent: number; replies: number }[];
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

/** Lifetime row counts per table, scoped to the organization. */
async function countRows(organizationId: string): Promise<DatabaseCounts> {
  const one = dsql<number>`COUNT(*)::int`;

  const [companyRows, contactRows, leadRows, emailRows, replyRows] = await Promise.all([
    db
      .select({
        total: one,
        sourced: dsql<number>`COUNT(*) FILTER (WHERE ${companies.hiringSignalSource} IS NOT NULL)::int`,
      })
      .from(companies)
      .where(eq(companies.organizationId, organizationId)),
    db.select({ total: one }).from(contacts).where(eq(contacts.organizationId, organizationId)),
    db.select({ total: one }).from(leads).where(eq(leads.organizationId, organizationId)),
    db.select({ total: one }).from(emails).where(eq(emails.organizationId, organizationId)),
    db.select({ total: one }).from(replies).where(eq(replies.organizationId, organizationId)),
  ]);

  return {
    companies: companyRows[0]?.total ?? 0,
    sourcedCompanies: companyRows[0]?.sourced ?? 0,
    contacts: contactRows[0]?.total ?? 0,
    leads: leadRows[0]?.total ?? 0,
    emails: emailRows[0]?.total ?? 0,
    replies: replyRows[0]?.total ?? 0,
  };
}

export async function getAnalyticsReport(
  organizationId: string,
  periodDays = 30,
): Promise<AnalyticsReport> {
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const [funnelRows, eventRows, replyRows, inboxRows, aiRows, apiRows, counts, daily] =
    await Promise.all([
      // Email funnel from the emails table itself.
      db
        .select({
          approved: dsql<number>`COUNT(*) FILTER (WHERE ${emails.approvedBy} IS NOT NULL)::int`,
          sent: dsql<number>`COUNT(*) FILTER (WHERE ${emails.sentAt} IS NOT NULL)::int`,
          bounced: dsql<number>`COUNT(*) FILTER (WHERE ${emails.status} = 'bounced')::int`,
          complained: dsql<number>`COUNT(*) FILTER (WHERE ${emails.status} = 'complained')::int`,
        })
        .from(emails)
        .where(and(eq(emails.organizationId, organizationId), gte(emails.createdAt, since))),

      // Delivery/open signals live in events, which only arrive once a provider
      // webhook is wired — zero here means "not measured", not "nobody opened".
      db
        .select({
          eventType: emailEvents.eventType,
          count: dsql<number>`COUNT(DISTINCT ${emailEvents.emailId})::int`,
        })
        .from(emailEvents)
        .where(
          and(eq(emailEvents.organizationId, organizationId), gte(emailEvents.occurredAt, since)),
        )
        .groupBy(emailEvents.eventType),

      db
        .select({
          total: dsql<number>`COUNT(*)::int`,
          interested: dsql<number>`COUNT(*) FILTER (WHERE ${replies.classification} = 'interested')::int`,
        })
        .from(replies)
        .where(and(eq(replies.organizationId, organizationId), gte(replies.receivedAt, since))),

      db
        .select({
          emailAddress: sendingInboxes.emailAddress,
          domain: sendingDomains.domain,
          status: sendingInboxes.status,
          provider: sendingInboxes.provider,
          reputationScore: sendingInboxes.reputationScore,
          dailyLimit: sendingInboxes.dailySendLimit,
          maxDailyLimit: sendingInboxes.maxDailySendLimit,
          sentToday: sendingInboxes.sentToday,
          totalSent: sendingInboxes.totalSent,
          totalBounced: sendingInboxes.totalBounced,
          warmupStartedAt: sendingInboxes.warmupStartedAt,
          warmupCompleted: sendingInboxes.warmupCompleted,
        })
        .from(sendingInboxes)
        .innerJoin(sendingDomains, eq(sendingInboxes.domainId, sendingDomains.id))
        .where(eq(sendingInboxes.organizationId, organizationId)),

      db
        .select({
          operation: aiUsage.operation,
          model: aiUsage.model,
          calls: dsql<number>`COUNT(*)::int`,
          inputTokens: dsql<number>`COALESCE(SUM(${aiUsage.inputTokens}), 0)::int`,
          outputTokens: dsql<number>`COALESCE(SUM(${aiUsage.outputTokens}), 0)::int`,
          costUsd: dsql<number>`COALESCE(SUM(${aiUsage.costUsd}), 0)::float`,
        })
        .from(aiUsage)
        .where(and(eq(aiUsage.organizationId, organizationId), gte(aiUsage.createdAt, since)))
        .groupBy(aiUsage.operation, aiUsage.model),

      db
        .select({
          provider: apiUsage.provider,
          calls: dsql<number>`COUNT(*)::int`,
          credits: dsql<number>`COALESCE(SUM(${apiUsage.creditsUsed}), 0)::int`,
          failures: dsql<number>`COUNT(*) FILTER (WHERE ${apiUsage.success} = false)::int`,
        })
        .from(apiUsage)
        .where(and(eq(apiUsage.organizationId, organizationId), gte(apiUsage.createdAt, since)))
        .groupBy(apiUsage.provider),

      // Lifetime totals — "what is in the database", not a windowed count.
      countRows(organizationId),

      db
        .select({
          day: dsql<string>`TO_CHAR(DATE_TRUNC('day', ${emails.sentAt}), 'YYYY-MM-DD')`,
          sent: dsql<number>`COUNT(*)::int`,
        })
        .from(emails)
        .where(
          and(
            eq(emails.organizationId, organizationId),
            gte(emails.sentAt, since),
            dsql`${emails.sentAt} IS NOT NULL`,
          ),
        )
        .groupBy(dsql`DATE_TRUNC('day', ${emails.sentAt})`)
        .orderBy(dsql`DATE_TRUNC('day', ${emails.sentAt})`),
    ]);

  const f = funnelRows[0] ?? { approved: 0, sent: 0, bounced: 0, complained: 0 };
  const eventMap = new Map(eventRows.map((r) => [r.eventType, r.count]));
  const r = replyRows[0] ?? { total: 0, interested: 0 };

  const sent = f.sent;
  const delivered = eventMap.get('delivered') ?? 0;
  const opened = eventMap.get('opened') ?? 0;

  const funnel: FunnelStats = {
    approved: f.approved,
    sent,
    delivered,
    opened,
    bounced: f.bounced || (eventMap.get('bounced') ?? 0),
    complained: f.complained || (eventMap.get('complained') ?? 0),
    replied: r.total,
    interested: r.interested,
    deliveryRate: rate(delivered, sent),
    openRate: rate(opened, sent),
    replyRate: rate(r.total, sent),
    interestedRate: rate(r.interested, sent),
    bounceRate: rate(f.bounced || (eventMap.get('bounced') ?? 0), sent),
    complaintRate: rate(f.complained || (eventMap.get('complained') ?? 0), sent),
  };

  const inboxes: InboxHealth[] = inboxRows.map((row) => ({
    emailAddress: row.emailAddress,
    domain: row.domain,
    status: row.status,
    provider: row.provider,
    reputationScore: row.reputationScore,
    dailyLimit: row.dailyLimit,
    maxDailyLimit: row.maxDailyLimit,
    sentToday: row.sentToday,
    totalSent: row.totalSent,
    totalBounced: row.totalBounced,
    bounceRate: rate(row.totalBounced, row.totalSent),
    warmupDay: row.warmupStartedAt
      ? Math.floor((Date.now() - row.warmupStartedAt.getTime()) / (24 * 60 * 60 * 1000)) + 1
      : null,
    warmupCompleted: row.warmupCompleted,
  }));

  const aiSpend: AiSpendRow[] = aiRows.map((row) => ({
    operation: row.operation,
    model: row.model,
    calls: row.calls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: Number(row.costUsd),
  }));

  const database = counts;
  const replyByDay = new Map<string, number>();

  return {
    periodDays,
    since,
    funnel,
    inboxes,
    aiSpend,
    aiTotalCost: aiSpend.reduce((sum, row) => sum + row.costUsd, 0),
    apiUsage: apiRows,
    database,
    dailySends: daily.map((d) => ({
      day: d.day,
      sent: d.sent,
      replies: replyByDay.get(d.day) ?? 0,
    })),
  };
}
