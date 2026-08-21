import { z } from 'zod';
import { db } from '@/db';
import { emails, leads, companies, contacts } from '@/db/schema';
import { and, eq, desc, sql as dsql } from 'drizzle-orm';
import {
  requireAuth,
  handleRoute,
  parseQuery,
  paginationSchema,
  paginationOffset,
} from '@/lib/api-helpers';

const querySchema = paginationSchema.extend({
  status: z.string().default('pending_approval'),
  kind: z.string().optional(),
});

/** The approval queue. Defaults to drafts awaiting a human. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const query = parseQuery(request, querySchema);

    const conditions = [eq(emails.organizationId, ctx.organizationId)];
    if (query.status !== 'all') conditions.push(dsql`${emails.status} = ${query.status}`);
    if (query.kind) conditions.push(dsql`${emails.kind} = ${query.kind}`);

    const where = and(...conditions);

    const [countRow] = await db
      .select({ count: dsql<number>`COUNT(*)::int` })
      .from(emails)
      .where(where);

    const rows = await db
      .select({
        id: emails.id,
        kind: emails.kind,
        status: emails.status,
        subject: emails.subject,
        bodyText: emails.bodyText,
        originalSubject: emails.originalSubject,
        originalBodyText: emails.originalBodyText,
        wasEditedByHuman: emails.wasEditedByHuman,
        toAddress: emails.toAddress,
        fromAddress: emails.fromAddress,
        scheduledFor: emails.scheduledFor,
        sentAt: emails.sentAt,
        failureReason: emails.failureReason,
        model: emails.model,
        costUsd: emails.costUsd,
        createdAt: emails.createdAt,
        leadId: leads.id,
        leadStatus: leads.status,
        companyName: companies.name,
        companyDomain: companies.domain,
        companyIndustry: companies.industry,
        hiringSignal: companies.hiringSignal,
        contactName: contacts.fullName,
        contactTitle: contacts.jobTitle,
        contactEmail: contacts.email,
        emailVerified: contacts.emailVerified,
      })
      .from(emails)
      .innerJoin(leads, eq(emails.leadId, leads.id))
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(where)
      .orderBy(desc(emails.createdAt))
      .limit(query.limit)
      .offset(paginationOffset(query));

    return {
      emails: rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: countRow?.count ?? 0,
        totalPages: Math.ceil((countRow?.count ?? 0) / query.limit),
      },
    };
  });
}
