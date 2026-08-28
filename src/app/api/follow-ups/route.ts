import { z } from 'zod';
import { db } from '@/db';
import { leads, companies, contacts, campaigns, emails } from '@/db/schema';
import { and, eq, isNotNull, desc, asc, sql as dsql, inArray } from 'drizzle-orm';
import { getJobQueue } from '@/lib/providers/queue';
import {
  requireAuth,
  requireWriteAccess,
  handleRoute,
  parseBody,
  audit,
  ApiError,
} from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * Follow-up pipeline: what is scheduled, what is already drafted and waiting.
 *
 * A follow-up only exists as a date on the lead until its wait elapses — the
 * draft is written then, and still needs approval. So "scheduled" and "drafted"
 * are genuinely different states and are reported separately.
 */
export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();

    const scheduled = await db
      .select({
        leadId: leads.id,
        companyName: companies.name,
        contactName: contacts.fullName,
        contactEmail: contacts.email,
        status: leads.status,
        followUpCount: leads.followUpCount,
        nextFollowUpAt: leads.nextFollowUpAt,
        lastContactedAt: leads.lastContactedAt,
        repliedAt: leads.repliedAt,
        campaignName: campaigns.name,
        maxFollowUps: campaigns.maxFollowUps,
      })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(
        and(
          eq(leads.organizationId, ctx.organizationId),
          isNotNull(leads.nextFollowUpAt),
          dsql`${leads.repliedAt} IS NULL`,
          dsql`${leads.status} IN ('contacted', 'follow_up_1_sent', 'follow_up_2_sent')`,
        ),
      )
      .orderBy(asc(leads.nextFollowUpAt))
      .limit(100);

    // Follow-up drafts already written and sitting in the approval queue.
    const pendingDrafts = await db
      .select({
        emailId: emails.id,
        leadId: emails.leadId,
        kind: emails.kind,
        subject: emails.subject,
        companyName: companies.name,
        contactEmail: emails.toAddress,
        createdAt: emails.createdAt,
      })
      .from(emails)
      .innerJoin(leads, eq(emails.leadId, leads.id))
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .where(
        and(
          eq(emails.organizationId, ctx.organizationId),
          eq(emails.status, 'pending_approval'),
          inArray(emails.kind, ['follow_up_1', 'follow_up_2', 'follow_up_3']),
        ),
      )
      .orderBy(desc(emails.createdAt))
      .limit(50);

    const now = Date.now();

    return {
      scheduled: scheduled.map((row) => ({
        ...row,
        nextFollowUpAt: row.nextFollowUpAt?.toISOString() ?? null,
        lastContactedAt: row.lastContactedAt?.toISOString() ?? null,
        repliedAt: row.repliedAt?.toISOString() ?? null,
        isDue: row.nextFollowUpAt ? row.nextFollowUpAt.getTime() <= now : false,
        maxFollowUps: row.maxFollowUps ?? 2,
      })),
      pendingDrafts: pendingDrafts.map((d) => ({
        ...d,
        createdAt: d.createdAt.toISOString(),
      })),
      counts: {
        scheduled: scheduled.length,
        due: scheduled.filter((r) => r.nextFollowUpAt && r.nextFollowUpAt.getTime() <= now).length,
        awaitingApproval: pendingDrafts.length,
      },
    };
  });
}

const patchSchema = z.object({
  leadId: z.string().uuid(),
  action: z.enum(['reschedule', 'cancel', 'draft_now']),
  /** Required for reschedule — when the next follow-up should happen. */
  nextFollowUpAt: z.string().datetime().optional(),
});

/** Reschedule, cancel, or immediately draft a lead's next follow-up. */
export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const body = await parseBody(request, patchSchema);

    const [lead] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, body.leadId), eq(leads.organizationId, ctx.organizationId)))
      .limit(1);

    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');

    if (body.action === 'cancel') {
      await db
        .update(leads)
        .set({ nextFollowUpAt: null, updatedAt: new Date() })
        .where(eq(leads.id, body.leadId));

      await audit({
        ctx,
        action: 'followup.cancel',
        entityType: 'lead',
        entityId: body.leadId,
        request,
      });
      return { message: 'Follow-up cancelled. No further follow-up will be drafted for this lead.' };
    }

    if (body.action === 'reschedule') {
      if (!body.nextFollowUpAt) {
        throw new ApiError(400, 'A new date is required to reschedule.', 'MISSING_DATE');
      }
      const when = new Date(body.nextFollowUpAt);
      await db
        .update(leads)
        .set({ nextFollowUpAt: when, updatedAt: new Date() })
        .where(eq(leads.id, body.leadId));

      await audit({
        ctx,
        action: 'followup.reschedule',
        entityType: 'lead',
        entityId: body.leadId,
        changes: { nextFollowUpAt: when.toISOString() },
        request,
      });
      return { message: `Follow-up moved to ${when.toLocaleDateString()}.` };
    }

    // draft_now — write the follow-up immediately instead of waiting for the
    // scheduled date. It still lands in the approval queue.
    if (lead.repliedAt) {
      throw new ApiError(
        409,
        'This lead has already replied — the sequence stops there.',
        'ALREADY_REPLIED',
      );
    }

    const jobId = await getJobQueue().enqueue(
      'generate_follow_up',
      { leadId: body.leadId },
      {
        organizationId: ctx.organizationId,
        priority: 10,
        idempotencyKey: `follow_up:${body.leadId}:${new Date().toISOString().slice(0, 16)}`,
      },
    );

    await audit({
      ctx,
      action: 'followup.draft_now',
      entityType: 'lead',
      entityId: body.leadId,
      metadata: { jobId },
      request,
    });

    return {
      message: jobId
        ? 'Follow-up is being written. It will appear in the approval queue shortly.'
        : 'A follow-up is already being written for this lead.',
    };
  });
}
