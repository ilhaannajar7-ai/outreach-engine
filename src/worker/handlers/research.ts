/**
 * Job: research_company
 *
 * Produces a cached research brief for a company. The cache is checked first —
 * five contacts at one company cost one research call, not five.
 */

import { db } from '@/db';
import { companies, organizations, aiResearch, leads, settings, type ScoredHook } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { researchCompany } from '@/lib/ai/operations';
import { readCompanyWebsite } from '@/lib/enrichment/website';
import { assessHook, assessResearch } from '@/lib/ai/hook-quality';
import { notify, notifyStopped } from '@/lib/notifications';
import { getJobQueue } from '@/lib/providers/queue';
import type { JobHandler } from '../types';

/** Research older than this is refreshed on next use. */
const CACHE_TTL_DAYS = 90;

export const researchHandler: JobHandler<{
  companyId: string;
  leadId?: string;
  force?: boolean;
}> = async (job) => {
  const { companyId, leadId, force } = job.payload;
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('research_company requires an organizationId');

  const [company] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
    .limit(1);

  if (!company) throw new Error(`Company ${companyId} not found`);

  // Reuse a fresh cached brief unless the caller explicitly asked for a refresh.
  if (!force) {
    const [cached] = await db
      .select()
      .from(aiResearch)
      .where(and(eq(aiResearch.companyId, companyId), eq(aiResearch.isStale, false)))
      .orderBy(desc(aiResearch.createdAt))
      .limit(1);

    const ageMs = cached ? Date.now() - cached.createdAt.getTime() : Infinity;
    if (cached && ageMs < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
      if (leadId) {
        await db
          .update(leads)
          .set({ researchId: cached.id, status: 'researched', updatedAt: new Date() })
          .where(eq(leads.id, leadId));
      }
      return { cached: true, researchId: cached.id, costUsd: 0 };
    }
  }

  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (leadId) {
    await db
      .update(leads)
      .set({ status: 'researching', updatedAt: new Date() })
      .where(eq(leads.id, leadId));
  }

  // Read their own site first. Without it research only has the CSV row, and
  // generic hooks are exactly what the quality gate rejects. Never fatal — a
  // site that is down or blocking us just means less material.
  const website = await readCompanyWebsite(company.domain);

  try {
    const { data, meta } = await researchCompany({
      organizationId,
      companyId,
      website,
      company: {
        name: company.name,
        domain: company.domain,
        industry: company.industry,
        sizeRange: company.sizeRange,
        location: company.location,
        description: company.description,
        hiringSignal: company.hiringSignal,
      },
      organization: {
        servicesOffered: organization?.servicesOffered ?? null,
        valueProposition: organization?.valueProposition ?? null,
      },
    });

    // Score every hook before anything is stored. A brief whose hooks are all
    // generic produces an email that reads as automated, which costs more in
    // domain reputation than the lead is worth — so it is caught here rather
    // than at the approval queue.
    const quality = assessResearch(data.hooks);
    const scoredHooks: ScoredHook[] = data.hooks
      .map((hook) => ({
        observation: hook.observation,
        inference: hook.inference,
        score: assessHook(hook).score,
      }))
      .sort((a, b) => b.score - a.score);

    // Supersede any previous brief so exactly one is current per company.
    await db
      .update(aiResearch)
      .set({ isStale: true })
      .where(eq(aiResearch.companyId, companyId));

    const [research] = await db
      .insert(aiResearch)
      .values({
        organizationId,
        companyId,
        summary: data.summary,
        painPoints: data.pain_points,
        opportunities: data.opportunities,
        valueProposition: data.value_proposition,
        personalizationHooks: scoredHooks,
        fitScore: Math.round(data.fit_score),
        hookQualityScore: quality.bestScore,
        disqualifiers: data.disqualifiers,
        rawResponse: data,
        model: meta.model,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        costUsd: meta.costUsd.toFixed(6),
        isStale: false,
        expiresAt: new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000),
      })
      .returning({ id: aiResearch.id });

    const researchId = research!.id;

    // Weak research still gets stored and still advances the lead — the
    // operator may know something the inputs don't contain. It is flagged, not
    // discarded, so it surfaces for a decision instead of quietly becoming a
    // generic email.
    const needsAttention = !quality.isUsable || data.fit_score < 40;
    const attentionReason = !quality.isUsable
      ? quality.summary
      : `Low fit score (${Math.round(data.fit_score)}/100): ${data.fit_reasoning}`;

    const leadUpdate = {
      researchId,
      status: 'researched' as const,
      lastError: null,
      requiresAttention: needsAttention,
      attentionReason: needsAttention ? attentionReason : null,
      updatedAt: new Date(),
    };

    // Every lead at this company benefits, not just the one that triggered it.
    await db
      .update(leads)
      .set(leadUpdate)
      .where(
        and(
          eq(leads.companyId, companyId),
          eq(leads.organizationId, organizationId),
          eq(leads.status, 'new'),
        ),
      );

    if (leadId) {
      await db.update(leads).set(leadUpdate).where(eq(leads.id, leadId));
    }

    // Hands-free path: strong research walks itself to a draft in the approval
    // queue. Weak research deliberately does not — it is flagged below instead,
    // because auto-generating from a generic brief is exactly how a domain ends
    // up sending automated-sounding mail. Sending still requires approval.
    if (leadId && !needsAttention) {
      const [autoGenerate] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(
          and(
            eq(settings.organizationId, organizationId),
            eq(settings.key, 'auto_generate_after_research'),
          ),
        )
        .limit(1);

      if (autoGenerate?.value === true) {
        await getJobQueue().enqueue(
          'generate_email',
          { leadId },
          { organizationId, idempotencyKey: `generate:${leadId}` },
        );
      }
    }

    if (needsAttention) {
      await notify({
        organizationId,
        tier: 'tier_2_auto_notified',
        title: `Weak research: ${company.name}`,
        message:
          `${attentionReason}\n\n` +
          'Emailing from this brief would read as automated. Add a specific hiring ' +
          'signal or company description and re-run research, or skip this lead.',
        relatedEntityType: 'company',
        relatedEntityId: companyId,
        actionUrl: leadId ? `/leads/${leadId}` : '/leads',
        actionLabel: 'Review lead',
      });
    }

    return {
      cached: false,
      researchId,
      costUsd: meta.costUsd,
      model: meta.model,
      fitScore: Math.round(data.fit_score),
      hookQuality: quality.bestScore,
      usableHooks: quality.usableHooks.length,
      // Whether the site was readable is the single best predictor of hook
      // quality, so it belongs in the job result when diagnosing weak research.
      websiteRead: website.ok,
      websitePages: website.pagesRead.length,
      ...(website.ok ? {} : { websiteError: website.error }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (leadId) {
      await db
        .update(leads)
        .set({ status: 'error', lastError: message, updatedAt: new Date() })
        .where(eq(leads.id, leadId));
    }

    // Budget exhaustion is a Tier-3 stop: nothing proceeds until a human decides.
    if ((error as { name?: string }).name === 'BudgetExceededError') {
      await notifyStopped(
        organizationId,
        'AI budget limit reached',
        `Research for ${company.name} was blocked. ${message}`,
        { actionUrl: '/settings/ai', actionLabel: 'Review AI budget' },
      );
    }

    throw error;
  }
};
