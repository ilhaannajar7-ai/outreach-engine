import { z } from 'zod';
import Papa from 'papaparse';
import { db } from '@/db';
import { companies, contacts, leads, settings } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getJobQueue } from '@/lib/providers/queue';
import { assignVariant } from '@/lib/experiments';
import { env } from '@/lib/env';
import { requireWriteAccess, handleRoute, audit, ApiError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** Header aliases so an export from Apollo, Hunter, or a spreadsheet all work. */
const COLUMN_ALIASES: Record<string, string[]> = {
  companyName: ['company', 'company name', 'organization', 'account', 'company_name'],
  companyDomain: ['domain', 'website', 'company domain', 'url', 'company_domain'],
  industry: ['industry', 'sector', 'vertical'],
  sizeRange: ['size', 'employees', 'company size', 'headcount', 'employee count'],
  location: ['location', 'city', 'address', 'region'],
  hiringSignal: ['hiring signal', 'signal', 'job title hiring', 'role hiring', 'note', 'notes'],
  email: ['email', 'email address', 'work email', 'contact email'],
  firstName: ['first name', 'firstname', 'given name', 'first_name'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'last_name'],
  fullName: ['name', 'full name', 'contact', 'contact name', 'full_name'],
  jobTitle: ['title', 'job title', 'position', 'role', 'job_title'],
};

function buildColumnMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const match = headers.find((h) => aliases.includes(h.toLowerCase().trim()));
    if (match) map[field] = match;
  }

  return map;
}

const MAX_ROWS = 5000;

/**
 * CSV lead import.
 *
 * Companies are deduplicated by domain, contacts by email — so importing the
 * same file twice adds nothing and costs nothing. Research is NOT queued
 * automatically unless the org opted in, because that spends AI budget.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();

    const formData = await request.formData().catch(() => null);
    if (!formData) throw new ApiError(400, 'Expected a multipart form upload', 'INVALID_FORM');

    const file = formData.get('file');
    if (!(file instanceof File)) {
      throw new ApiError(400, 'No file was uploaded under the field name "file".', 'NO_FILE');
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new ApiError(400, 'File is larger than 10MB.', 'FILE_TOO_LARGE');
    }

    const campaignId = formData.get('campaignId');
    const text = await file.text();

    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    if (parsed.errors.length > 0 && parsed.data.length === 0) {
      throw new ApiError(
        400,
        `Could not read the CSV: ${parsed.errors[0]?.message ?? 'unknown parse error'}`,
        'PARSE_ERROR',
      );
    }
    if (parsed.data.length === 0) {
      throw new ApiError(400, 'The file has no data rows.', 'EMPTY_FILE');
    }
    if (parsed.data.length > MAX_ROWS) {
      throw new ApiError(
        400,
        `The file has ${parsed.data.length} rows; the limit is ${MAX_ROWS} per import.`,
        'TOO_MANY_ROWS',
      );
    }

    const headers = parsed.meta.fields ?? [];
    const columns = buildColumnMap(headers);

    if (!columns.email) {
      throw new ApiError(
        400,
        `No email column found. Expected one of: ${COLUMN_ALIASES.email!.join(', ')}. Found: ${headers.join(', ')}.`,
        'NO_EMAIL_COLUMN',
      );
    }
    if (!columns.companyName && !columns.companyDomain) {
      throw new ApiError(
        400,
        'No company column found. Include a "company" or "domain" column.',
        'NO_COMPANY_COLUMN',
      );
    }

    const [autoResearchSetting] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.organizationId, ctx.organizationId),
          eq(settings.key, 'auto_research_on_import'),
        ),
      )
      .limit(1);

    const autoResearch = autoResearchSetting?.value === true;
    const queue = getJobQueue();

    let imported = 0;
    let duplicates = 0;
    const errors: { row: number; reason: string }[] = [];
    const companyIds = new Set<string>();
    const toVerify: { contactId: string; leadId: string }[] = [];

    const get = (row: Record<string, string>, field: string): string | null => {
      const column = columns[field];
      if (!column) return null;
      const value = row[column]?.trim();
      return value && value.length > 0 ? value : null;
    };

    for (const [index, row] of parsed.data.entries()) {
      const rowNumber = index + 2; // +1 for zero-index, +1 for the header row

      try {
        const rawEmail = get(row, 'email');
        if (!rawEmail) {
          errors.push({ row: rowNumber, reason: 'Missing email' });
          continue;
        }

        const email = rawEmail.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push({ row: rowNumber, reason: `"${rawEmail}" is not a valid email address` });
          continue;
        }

        const domain =
          get(row, 'companyDomain')
            ?.toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .split('/')[0] ??
          email.split('@')[1] ??
          null;

        const companyName = get(row, 'companyName') ?? domain ?? 'Unknown company';

        let [company] = domain
          ? await db
              .select()
              .from(companies)
              .where(
                and(eq(companies.organizationId, ctx.organizationId), eq(companies.domain, domain)),
              )
              .limit(1)
          : [];

        if (!company) {
          const hiringSignal = get(row, 'hiringSignal');
          [company] = await db
            .insert(companies)
            .values({
              organizationId: ctx.organizationId,
              name: companyName,
              domain,
              industry: get(row, 'industry'),
              sizeRange: get(row, 'sizeRange'),
              location: get(row, 'location'),
              hiringSignal,
              hiringSignalSource: hiringSignal ? 'csv_import' : null,
              hiringSignalSeenAt: hiringSignal ? new Date() : null,
              source: 'csv_import',
            })
            .returning();
        }

        let [contact] = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.email, email)))
          .limit(1);

        if (!contact) {
          const firstName = get(row, 'firstName');
          const lastName = get(row, 'lastName');
          const fullName =
            get(row, 'fullName') ?? ([firstName, lastName].filter(Boolean).join(' ') || null);

          [contact] = await db
            .insert(contacts)
            .values({
              organizationId: ctx.organizationId,
              companyId: company!.id,
              email,
              firstName,
              lastName,
              fullName,
              jobTitle: get(row, 'jobTitle'),
              source: 'csv_import',
            })
            .returning();
        }

        // Never re-add someone who opted out, whatever the file says.
        if (contact!.isUnsubscribed || contact!.isSuppressed) {
          errors.push({ row: rowNumber, reason: `${email} is unsubscribed or suppressed` });
          continue;
        }

        const [lead] = await db
          .insert(leads)
          .values({
            organizationId: ctx.organizationId,
            companyId: company!.id,
            contactId: contact!.id,
            campaignId: typeof campaignId === 'string' && campaignId ? campaignId : null,
            // Assigned at creation and never changed. Null when the campaign
            // has fewer than two active variants — no experiment is running.
            variantId:
              (
                await assignVariant({
                  organizationId: ctx.organizationId,
                  campaignId: typeof campaignId === 'string' && campaignId ? campaignId : null,
                })
              )?.id ?? null,
            status: 'new',
          })
          .onConflictDoNothing()
          .returning();

        if (!lead) {
          duplicates++;
          continue;
        }

        imported++;
        companyIds.add(company!.id);

        // A CSV address is unverified until proven otherwise. Queue verification
        // so the send gate has a real verdict rather than assuming the file was
        // clean — bounces from a stale list are exactly what burns a domain.
        if (env.ENRICHMENT_PROVIDER !== 'none' && !contact!.emailVerified) {
          toVerify.push({ contactId: contact!.id, leadId: lead.id });
        }
      } catch (error) {
        errors.push({
          row: rowNumber,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Verify imported addresses before they can be sent to.
    let verificationQueued = 0;
    for (const target of toVerify) {
      const jobId = await queue.enqueue(
        'verify_contact_email',
        { contactId: target.contactId, leadId: target.leadId },
        { organizationId: ctx.organizationId, idempotencyKey: `verify:${target.contactId}` },
      );
      if (jobId) verificationQueued++;
    }

    let researchQueued = 0;
    if (autoResearch) {
      for (const companyId of companyIds) {
        const jobId = await queue.enqueue(
          'research_company',
          { companyId },
          {
            organizationId: ctx.organizationId,
            idempotencyKey: `research:${companyId}:${new Date().toISOString().slice(0, 10)}`,
          },
        );
        if (jobId) researchQueued++;
      }
    }

    await audit({
      ctx,
      action: 'lead.import',
      entityType: 'lead',
      metadata: { imported, duplicates, errorCount: errors.length, filename: file.name },
      request,
    });

    return {
      imported,
      duplicates,
      // Only the first 50 errors — a badly formatted file should not produce a
      // megabyte of JSON.
      errors: errors.slice(0, 50),
      errorCount: errors.length,
      companiesAffected: companyIds.size,
      researchQueued,
      verificationQueued,
      message:
        (autoResearch
          ? `Imported ${imported} leads. Research queued for ${researchQueued} companies.`
          : `Imported ${imported} leads. Run research from the Leads page when you're ready — it costs AI credits.`) +
        (verificationQueued > 0
          ? ` ${verificationQueued} address${verificationQueued === 1 ? '' : 'es'} queued for verification.`
          : ''),
    };
  });
}
