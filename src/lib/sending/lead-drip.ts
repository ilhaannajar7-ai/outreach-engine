/**
 * Feed leads into the pipeline at the rate it can actually consume them.
 *
 * A batch import is thousands of rows, but sending is capped per day, so
 * researching and drafting the whole batch on arrival is wrong three times
 * over: it spends the AI budget months before the emails can go out, it
 * consumes verification credits in one burst that a monthly quota cannot
 * absorb, and research goes stale (cached 90 days) long before the email built
 * on it is sent.
 *
 * So each day this promotes only as many leads as the day's sending capacity
 * justifies. The rest sit untouched and cost nothing until their turn.
 */

import { db, sql } from '@/db';
import { leads, contacts, settings } from '@/db/schema';
import { and, eq, isNull, asc } from 'drizzle-orm';
import { getJobQueue } from '@/lib/providers/queue';
import { getRemainingCapacityToday } from '@/lib/sending/inbox-rotation';
import { env } from '@/lib/env';

/** Emails one lead consumes over its life: the initial plus its follow-ups. */
const TOUCHES_PER_LEAD = 3;

export interface DripResult {
  target: number;
  promoted: number;
  verificationQueued: number;
  pendingApproval: number;
  queueCap: number;
  reason?: string;
}

/**
 * How deep the approval queue may get before intake pauses, as a multiple of
 * the daily target. Reviewing in one sitting is the intended workflow, so the
 * queue is allowed to build for several days — but not without bound, because
 * a draft written today and approved in three weeks was built on research that
 * has moved on.
 */
const QUEUE_DEPTH_DAYS = 4;

async function numericSetting(
  organizationId: string,
  key: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.organizationId, organizationId), eq(settings.key, key)))
    .limit(1);

  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * How many new leads to start today.
 *
 * Explicit setting wins. Otherwise derive it from sending capacity: a lead
 * eventually consumes one initial plus its follow-ups, and follow-ups draw on
 * the same daily allowance, so starting capacity/3 per day is what keeps the
 * queue from outrunning the send limit.
 */
async function dailyTarget(organizationId: string): Promise<number> {
  const explicit = await numericSetting(organizationId, 'daily_lead_intake');
  if (explicit !== undefined) return explicit;

  const capacity = await getRemainingCapacityToday(organizationId);
  return Math.max(0, Math.floor(capacity.globalLimit / TOUCHES_PER_LEAD));
}

/**
 * Promote the next untouched leads into research (which drafts the email when
 * the org has opted in). Safe to run daily; it never promotes a lead twice
 * because status moves off 'new' as soon as research starts.
 */
export async function dripNewLeads(organizationId: string): Promise<DripResult> {
  const queue = getJobQueue();

  // Anything already waiting for a human is capacity the pipeline has not used
  // yet, so it counts against today's intake — otherwise an unreviewed queue
  // keeps growing while the drip cheerfully adds more.
  const pendingRows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM emails
    WHERE organization_id = ${organizationId} AND status = 'pending_approval'
  `;
  const pendingApproval = pendingRows[0]?.count ?? 0;

  const target = await dailyTarget(organizationId);

  // Two separate limits: how many to start today, and how many may be waiting
  // for review at once. Keeping them apart is what lets the queue build up to a
  // reviewable batch while intake stays at a sustainable daily rate.
  const configuredCap = await numericSetting(organizationId, 'max_pending_approval');
  const queueCap = configuredCap ?? target * QUEUE_DEPTH_DAYS;

  const room = Math.min(target, Math.max(0, queueCap - pendingApproval));

  if (room === 0) {
    return {
      target,
      promoted: 0,
      verificationQueued: 0,
      pendingApproval,
      queueCap,
      reason:
        pendingApproval >= queueCap
          ? `${pendingApproval} draft(s) are waiting for approval (cap ${queueCap}) — reviewing them releases the next batch.`
          : 'No intake budgeted for today.',
    };
  }

  const candidates = await db
    .select({
      leadId: leads.id,
      companyId: leads.companyId,
      contactId: contacts.id,
      emailVerified: contacts.emailVerified,
      isSuppressed: contacts.isSuppressed,
      isUnsubscribed: contacts.isUnsubscribed,
    })
    .from(leads)
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .where(
      and(
        eq(leads.organizationId, organizationId),
        eq(leads.status, 'new'),
        isNull(leads.researchId),
        eq(contacts.isSuppressed, false),
        eq(contacts.isUnsubscribed, false),
      ),
    )
    // Oldest first, so an imported batch is worked in the order it arrived.
    .orderBy(asc(leads.createdAt))
    .limit(room);

  let promoted = 0;
  let verificationQueued = 0;

  for (const lead of candidates) {
    // Verify before spending research on an address that may not exist. The
    // handler stops itself on a quota error rather than burning the month's
    // remaining credits on retries.
    if (env.ENRICHMENT_PROVIDER !== 'none' && !lead.emailVerified) {
      const id = await queue.enqueue(
        'verify_contact_email',
        { contactId: lead.contactId, leadId: lead.leadId },
        { organizationId, idempotencyKey: `verify:${lead.contactId}` },
      );
      if (id) verificationQueued++;
    }

    const researchId = await queue.enqueue(
      'research_company',
      { companyId: lead.companyId, leadId: lead.leadId },
      {
        organizationId,
        // One research job per company per day, so several contacts at the same
        // company share the one call rather than racing.
        idempotencyKey: `research:${lead.companyId}:${new Date().toISOString().slice(0, 10)}`,
      },
    );
    if (researchId) promoted++;
  }

  return { target, promoted, verificationQueued, pendingApproval, queueCap };
}
