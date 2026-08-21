import { z } from 'zod';
import { db } from '@/db';
import { leads, companies, contacts, campaigns } from '@/db/schema';
import { and, eq, desc, ilike, or, sql as dsql } from 'drizzle-orm';
import {
  requireAuth,
  requireWriteAccess,
  handleRoute,
  parseQuery,
  parseBody,
  paginationSchema,
  paginationOffset,
  audit,
  ApiError,
} from '@/lib/api-helpers';

const listQuerySchema = paginationSchema.extend({
  status: z.string().optional(),
  search: z.string().optional(),
  campaignId: z.string().uuid().optional(),
  requiresAttention: z.enum(['true', 'false']).optional(),
});

export async function GET(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const query = parseQuery(request, listQuerySchema);

    const conditions = [eq(leads.organizationId, ctx.organizationId)];

    if (query.status) {
      conditions.push(dsql`${leads.status} = ${query.status}`);
    }
    if (query.campaignId) {
      conditions.push(eq(leads.campaignId, query.campaignId));
    }
    if (query.requiresAttention) {
      conditions.push(eq(leads.requiresAttention, query.requiresAttention === 'true'));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      const searchCondition = or(
        ilike(companies.name, term),
        ilike(contacts.email, term),
        ilike(contacts.fullName, term),
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    const where = and(...conditions);

    const [countRow] = await db
      .select({ count: dsql<number>`COUNT(*)::int` })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(where);

    const rows = await db
      .select({
        id: leads.id,
        status: leads.status,
        priority: leads.priority,
        followUpCount: leads.followUpCount,
        nextFollowUpAt: leads.nextFollowUpAt,
        firstContactedAt: leads.firstContactedAt,
        lastContactedAt: leads.lastContactedAt,
        repliedAt: leads.repliedAt,
        requiresAttention: leads.requiresAttention,
        attentionReason: leads.attentionReason,
        lastError: leads.lastError,
        researchId: leads.researchId,
        createdAt: leads.createdAt,
        companyId: companies.id,
        companyName: companies.name,
        companyDomain: companies.domain,
        companyIndustry: companies.industry,
        hiringSignal: companies.hiringSignal,
        contactId: contacts.id,
        contactName: contacts.fullName,
        contactEmail: contacts.email,
        contactTitle: contacts.jobTitle,
        emailVerified: contacts.emailVerified,
        isUnsubscribed: contacts.isUnsubscribed,
        campaignName: campaigns.name,
      })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(where)
      .orderBy(desc(leads.requiresAttention), desc(leads.priority), desc(leads.updatedAt))
      .limit(query.limit)
      .offset(paginationOffset(query));

    return {
      leads: rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: countRow?.count ?? 0,
        totalPages: Math.ceil((countRow?.count ?? 0) / query.limit),
      },
    };
  });
}

const createLeadSchema = z.object({
  companyName: z.string().min(1).max(255),
  companyDomain: z.string().max(255).optional(),
  industry: z.string().max(255).optional(),
  sizeRange: z.string().max(50).optional(),
  location: z.string().max(255).optional(),
  description: z.string().optional(),
  hiringSignal: z.string().optional(),
  hiringSignalUrl: z.string().url().optional(),

  contactEmail: z.string().email().max(320),
  contactFirstName: z.string().max(100).optional(),
  contactLastName: z.string().max(100).optional(),
  contactTitle: z.string().max(255).optional(),

  campaignId: z.string().uuid().optional(),
  priority: z.number().int().min(0).max(100).default(0),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const body = await parseBody(request, createLeadSchema);

    const email = body.contactEmail.toLowerCase().trim();
    const domain = body.companyDomain?.toLowerCase().trim() ?? email.split('@')[1] ?? null;

    // Company is keyed on domain so importing five contacts from one company
    // produces one company row and one research brief.
    let [company] = domain
      ? await db
          .select()
          .from(companies)
          .where(and(eq(companies.organizationId, ctx.organizationId), eq(companies.domain, domain)))
          .limit(1)
      : [];

    if (!company) {
      [company] = await db
        .insert(companies)
        .values({
          organizationId: ctx.organizationId,
          name: body.companyName,
          domain,
          industry: body.industry ?? null,
          sizeRange: body.sizeRange ?? null,
          location: body.location ?? null,
          description: body.description ?? null,
          hiringSignal: body.hiringSignal ?? null,
          hiringSignalUrl: body.hiringSignalUrl ?? null,
          hiringSignalSeenAt: body.hiringSignal ? new Date() : null,
          source: 'manual',
        })
        .returning();
    }

    let [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.email, email)))
      .limit(1);

    if (!contact) {
      const fullName = [body.contactFirstName, body.contactLastName].filter(Boolean).join(' ');
      [contact] = await db
        .insert(contacts)
        .values({
          organizationId: ctx.organizationId,
          companyId: company!.id,
          email,
          firstName: body.contactFirstName ?? null,
          lastName: body.contactLastName ?? null,
          fullName: fullName || null,
          jobTitle: body.contactTitle ?? null,
          source: 'manual',
        })
        .returning();
    }

    if (contact!.isUnsubscribed || contact!.isSuppressed) {
      throw new ApiError(
        409,
        'That contact has unsubscribed or is suppressed and cannot be added to a campaign.',
        'CONTACT_SUPPRESSED',
      );
    }

    const [lead] = await db
      .insert(leads)
      .values({
        organizationId: ctx.organizationId,
        companyId: company!.id,
        contactId: contact!.id,
        campaignId: body.campaignId ?? null,
        priority: body.priority,
        status: 'new',
      })
      .onConflictDoNothing()
      .returning();

    if (!lead) {
      throw new ApiError(409, 'This contact is already a lead in that campaign.', 'DUPLICATE_LEAD');
    }

    await audit({
      ctx,
      action: 'lead.create',
      entityType: 'lead',
      entityId: lead.id,
      metadata: { company: body.companyName, contact: email },
      request,
    });

    return { lead, company, contact };
  });
}
