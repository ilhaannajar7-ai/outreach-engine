/**
 * Jobs: find_contacts and verify_contact_email
 *
 * These turn a company into a verified, relevant person to email — the front of
 * the funnel. Two separate jobs, because the two concerns fail differently:
 *   - find_contacts spends a search credit and picks the right person
 *   - verify_contact_email spends a verification credit and confirms the address
 *
 * Keeping them apart means a CSV-imported contact (already known, just
 * unverified) can be verified without a wasted search, and a re-run of
 * discovery does not re-verify everyone.
 */

import { db } from '@/db';
import { companies, contacts, leads, campaigns } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getEnrichmentService, EnrichmentQuotaError } from '@/lib/providers/enrichment';
import { rankContacts, targetFilters } from '@/lib/enrichment/targeting';
import { recordApiUsage } from '@/lib/enrichment/usage';
import { notify, notifyStopped } from '@/lib/notifications';
import type { JobHandler } from '../types';

/**
 * Discover the decision-maker at a company and create a verified lead.
 */
export const findContactsHandler: JobHandler<{
  companyId: string;
  campaignId?: string | null;
  /** Also queue research once a verified contact exists. */
  thenResearch?: boolean;
}> = async (job) => {
  const { companyId, campaignId, thenResearch } = job.payload;
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('find_contacts requires an organizationId');

  const [company] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
    .limit(1);

  if (!company) throw new Error(`Company ${companyId} not found`);
  if (!company.domain) {
    return { skipped: true, reason: 'Company has no domain — cannot search for contacts.' };
  }

  // Campaign targeting narrows who we look for; falls back to the outsourcing
  // decision-maker defaults.
  let campaignRole: string | null = null;
  if (campaignId) {
    const [campaign] = await db
      .select({ targetRole: campaigns.targetRole })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    campaignRole = campaign?.targetRole ?? null;
  }
  const filters = targetFilters(campaignRole);

  const enrichment = getEnrichmentService();
  const started = Date.now();

  let found;
  try {
    found = await enrichment.findContacts({
      companyDomain: company.domain,
      companyName: company.name,
      jobTitles: filters.jobTitles,
      seniorities: filters.seniorities,
      departments: filters.departments,
      limit: 10,
    });
  } catch (error) {
    if (error instanceof EnrichmentQuotaError) {
      // Out of credits is a stop-and-tell, not a retry — retrying just fails
      // again and the operator needs to top up or wait for the reset.
      await notifyStopped(
        organizationId,
        'Contact search stopped — Hunter credits exhausted',
        'The enrichment provider is out of search credits. Discovery is paused until credits ' +
          'reset or the plan is topped up. Verification and everything downstream keep working.',
        { actionUrl: '/leads', actionLabel: 'Review leads' },
      );
    }
    await recordApiUsage({
      organizationId,
      provider: enrichment.name,
      endpoint: 'domain-search',
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    });
    throw error;
  }

  await recordApiUsage({
    organizationId,
    provider: enrichment.name,
    endpoint: 'domain-search',
    success: true,
    durationMs: Date.now() - started,
  });

  const { best, ranked, rejected } = rankContacts(found);

  if (!best) {
    // A domain with people, but none of them the right person, is a real
    // finding — flag it rather than silently producing nothing.
    await db
      .update(companies)
      .set({ updatedAt: new Date() })
      .where(eq(companies.id, companyId));

    await notify({
      organizationId,
      tier: 'tier_2_auto_notified',
      title: `No suitable contact at ${company.name}`,
      message:
        found.length === 0
          ? 'Hunter returned no contacts for this domain. It may be too small to be indexed, or the domain is wrong.'
          : `Found ${found.length} contact(s) but none in a decision-making finance or operations role. ` +
            `Closest was "${rejected[0]?.jobTitle ?? 'unknown'}".`,
      relatedEntityType: 'company',
      relatedEntityId: companyId,
      actionUrl: '/leads',
      actionLabel: 'Review',
    });

    return { found: found.length, usable: 0, reason: 'No decision-maker matched' };
  }

  // Create (or reuse) the contact. Unverified for now — verification is its own
  // credit and its own job, queued next.
  const [contact] = await db
    .insert(contacts)
    .values({
      organizationId,
      companyId,
      firstName: best.firstName ?? null,
      lastName: best.lastName ?? null,
      fullName: best.fullName ?? ([best.firstName, best.lastName].filter(Boolean).join(' ') || null),
      email: best.email,
      jobTitle: best.jobTitle ?? null,
      seniority: best.seniority ?? null,
      department: best.department ?? null,
      linkedinUrl: best.linkedinUrl ?? null,
      source: enrichment.name,
    })
    .onConflictDoUpdate({
      target: [contacts.organizationId, contacts.email],
      set: { jobTitle: best.jobTitle ?? null, updatedAt: new Date() },
    })
    .returning();

  // Create the lead if this contact does not already have one in this campaign.
  const [lead] = await db
    .insert(leads)
    .values({
      organizationId,
      companyId,
      contactId: contact!.id,
      campaignId: campaignId ?? null,
      status: 'new',
    })
    .onConflictDoNothing()
    .returning();

  // Verify before anything downstream can send. Idempotency-keyed on the
  // contact so a re-discovery does not double-verify.
  const { getJobQueue } = await import('@/lib/providers/queue');
  const queue = getJobQueue();
  await queue.enqueue(
    'verify_contact_email',
    { contactId: contact!.id, leadId: lead?.id ?? null, thenResearch: thenResearch ?? false },
    { organizationId, idempotencyKey: `verify:${contact!.id}` },
  );

  return {
    found: found.length,
    chose: {
      name: contact!.fullName,
      title: contact!.jobTitle,
      email: contact!.email,
      targetScore: best.targetScore,
      reason: best.reason,
    },
    otherCandidates: ranked.slice(1).length,
    verificationQueued: true,
  };
};

/**
 * Verify one contact's address and gate the lead on the result.
 */
export const verifyContactEmailHandler: JobHandler<{
  contactId: string;
  leadId?: string | null;
  thenResearch?: boolean;
}> = async (job) => {
  const { contactId, leadId, thenResearch } = job.payload;
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('verify_contact_email requires an organizationId');

  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)))
    .limit(1);

  if (!contact) throw new Error(`Contact ${contactId} not found`);

  const enrichment = getEnrichmentService();
  const started = Date.now();

  let result;
  try {
    result = await enrichment.verifyEmail(contact.email);
  } catch (error) {
    if (error instanceof EnrichmentQuotaError) {
      await notifyStopped(
        organizationId,
        'Email verification stopped — Hunter credits exhausted',
        'The enrichment provider is out of verification credits. Unverified leads will not be ' +
          'sent to until this is resolved — the send gate blocks them by design.',
        { actionUrl: '/sending/limits', actionLabel: 'Review' },
      );
    }
    await recordApiUsage({
      organizationId,
      provider: enrichment.name,
      endpoint: 'email-verifier',
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    });
    throw error;
  }

  await recordApiUsage({
    organizationId,
    provider: enrichment.name,
    endpoint: 'email-verifier',
    success: true,
    durationMs: Date.now() - started,
  });

  await db
    .update(contacts)
    .set({
      emailVerified: result.isSafeToSend,
      emailVerificationStatus: result.status,
      emailVerificationScore: result.score,
      emailVerifiedAt: new Date(),
      // A dud address is suppressed outright, so no future job ever tries it.
      ...(result.status === 'invalid' || result.isDisposable
        ? { isSuppressed: true, suppressionReason: `Verification: ${result.status}` }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));

  // An address that cannot safely be sent to should not sit in the pipeline
  // looking ready. Flag the lead so it surfaces for a human decision instead of
  // silently never being contacted.
  if (leadId && !result.isSafeToSend) {
    await db
      .update(leads)
      .set({
        requiresAttention: true,
        attentionReason: `Email did not verify (${result.status}, score ${result.score}). Not safe to send — find a better address or skip.`,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, leadId));
  }

  // Only research a lead worth pursuing. Verifying first means AI budget is
  // never spent researching a company we can't actually email.
  if (thenResearch && result.isSafeToSend && leadId) {
    const [lead] = await db
      .select({ companyId: leads.companyId })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (lead) {
      const { getJobQueue } = await import('@/lib/providers/queue');
      await getJobQueue().enqueue(
        'research_company',
        { companyId: lead.companyId, leadId },
        { organizationId, idempotencyKey: `research:${lead.companyId}` },
      );
    }
  }

  return {
    email: contact.email,
    status: result.status,
    score: result.score,
    safeToSend: result.isSafeToSend,
  };
};
