import { z } from 'zod';
import { db } from '@/db';
import { leads, companies, contacts, emails, replies, aiResearch, campaigns } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import {
  requireAuth,
  requireWriteAccess,
  handleRoute,
  parseBody,
  audit,
  ApiError,
} from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const { id } = await params;

    const [row] = await db
      .select({
        lead: leads,
        company: companies,
        contact: contacts,
        research: aiResearch,
        campaign: campaigns,
      })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .leftJoin(aiResearch, eq(leads.researchId, aiResearch.id))
      .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(and(eq(leads.id, id), eq(leads.organizationId, ctx.organizationId)))
      .limit(1);

    if (!row) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');

    const leadEmails = await db
      .select()
      .from(emails)
      .where(eq(emails.leadId, id))
      .orderBy(emails.createdAt);

    const leadReplies = await db
      .select()
      .from(replies)
      .where(eq(replies.leadId, id))
      .orderBy(desc(replies.receivedAt));

    return { ...row, emails: leadEmails, replies: leadReplies };
  });
}

const updateSchema = z.object({
  status: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  notes: z.string().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.string().nullable().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;
    const body = await parseBody(request, updateSchema);

    const [existing] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.organizationId, ctx.organizationId)))
      .limit(1);

    if (!existing) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status !== undefined) updates.status = body.status;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.requiresAttention !== undefined) {
      updates.requiresAttention = body.requiresAttention;
      // Clearing the flag must clear the reason too, or the dashboard shows a
      // stale explanation next to a lead that no longer needs anything.
      if (!body.requiresAttention) updates.attentionReason = null;
    }
    if (body.attentionReason !== undefined) updates.attentionReason = body.attentionReason;

    const [updated] = await db
      .update(leads)
      .set(updates)
      .where(eq(leads.id, id))
      .returning();

    await audit({
      ctx,
      action: 'lead.update',
      entityType: 'lead',
      entityId: id,
      changes: body,
      request,
    });

    return updated;
  });
}
