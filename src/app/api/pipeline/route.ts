import { db } from '@/db';
import { leads, companies, contacts, campaigns, strategyVariants, emails, aiResearch } from '@/db/schema';
import { and, eq, desc, isNotNull, sql as dsql } from 'drizzle-orm';
import { requireAuth, handleRoute } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * The live pipeline: every lead in flight, why it was targeted, where it is,
 * and what happens to it next.
 *
 * One endpoint rather than several because the value is seeing them together —
 * a new lead, a scheduled follow-up and a waiting draft are the same pipeline
 * at different stages, and switching pages to compare them defeats the point.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const limit = Math.min(200, Number(new URL(request.url).searchParams.get('limit') ?? 100));

    const rows = await db
      .select({
        leadId: leads.id,
        status: leads.status,
        createdAt: leads.createdAt,
        firstContactedAt: leads.firstContactedAt,
        lastContactedAt: leads.lastContactedAt,
        nextFollowUpAt: leads.nextFollowUpAt,
        repliedAt: leads.repliedAt,
        followUpCount: leads.followUpCount,
        requiresAttention: leads.requiresAttention,
        attentionReason: leads.attentionReason,

        companyName: companies.name,
        companyDomain: companies.domain,
        industry: companies.industry,
        sizeRange: companies.sizeRange,
        location: companies.location,
        // Why we targeted them at all.
        hiringSignal: companies.hiringSignal,
        hiringSignalSource: companies.hiringSignalSource,

        contactName: contacts.fullName,
        contactTitle: contacts.jobTitle,
        contactEmail: contacts.email,
        emailVerified: contacts.emailVerified,

        campaignName: campaigns.name,
        maxFollowUps: campaigns.maxFollowUps,
        variantName: strategyVariants.name,

        // What the research actually found — the hook is the reason the email works.
        fitScore: aiResearch.fitScore,
        hookQuality: aiResearch.hookQualityScore,
        researchSummary: aiResearch.summary,
        hooks: aiResearch.personalizationHooks,

        sentCount: dsql<number>`(
          SELECT COUNT(*)::int FROM emails e
          WHERE e.lead_id = ${leads.id}
            AND e.status IN ('sent','delivered','bounced','complained')
        )`,
        pendingDraftId: dsql<string | null>`(
          SELECT e.id FROM emails e
          WHERE e.lead_id = ${leads.id} AND e.status = 'pending_approval'
          ORDER BY e.created_at DESC LIMIT 1
        )`,
        lastOpenCount: dsql<number>`(
          SELECT COALESCE(SUM(e.open_count),0)::int FROM emails e WHERE e.lead_id = ${leads.id}
        )`,
      })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .leftJoin(strategyVariants, eq(leads.variantId, strategyVariants.id))
      .leftJoin(aiResearch, eq(leads.researchId, aiResearch.id))
      .where(eq(leads.organizationId, ctx.organizationId))
      .orderBy(desc(leads.updatedAt))
      .limit(limit);

    const now = Date.now();

    const items = rows.map((r) => {
      const hooks = normalizeHooks(r.hooks);
      return {
        ...r,
        createdAt: r.createdAt.toISOString(),
        firstContactedAt: r.firstContactedAt?.toISOString() ?? null,
        lastContactedAt: r.lastContactedAt?.toISOString() ?? null,
        nextFollowUpAt: r.nextFollowUpAt?.toISOString() ?? null,
        repliedAt: r.repliedAt?.toISOString() ?? null,
        followUpDue: r.nextFollowUpAt ? r.nextFollowUpAt.getTime() <= now : false,
        maxFollowUps: r.maxFollowUps ?? 2,
        topHook: hooks[0] ?? null,
        hooks: undefined,
      };
    });

    // Stage counts drive the summary strip; computed here so every client agrees.
    const counts = {
      total: items.length,
      newLeads: items.filter((i) => ['new', 'researching', 'researched', 'generating'].includes(i.status)).length,
      awaitingApproval: items.filter((i) => i.pendingDraftId).length,
      contacted: items.filter((i) => i.firstContactedAt && !i.repliedAt).length,
      followUpsScheduled: items.filter((i) => i.nextFollowUpAt && !i.repliedAt).length,
      followUpsDue: items.filter((i) => i.followUpDue && !i.repliedAt).length,
      replied: items.filter((i) => i.repliedAt).length,
      needsAttention: items.filter((i) => i.requiresAttention).length,
    };

    return { items, counts, fetchedAt: new Date().toISOString() };
  });
}

/** Stored hooks may be strings or {observation,inference,score} objects. */
function normalizeHooks(raw: unknown): { observation: string; score: number }[] {
  if (typeof raw === 'string') {
    try {
      return normalizeHooks(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      if (typeof entry === 'string') return { observation: entry, score: 0 };
      if (entry && typeof entry === 'object' && 'observation' in entry) {
        const hook = entry as { observation?: unknown; score?: unknown };
        return {
          observation: String(hook.observation ?? ''),
          score: typeof hook.score === 'number' ? hook.score : 0,
        };
      }
      return null;
    })
    .filter((h): h is { observation: string; score: number } => Boolean(h?.observation))
    .sort((a, b) => b.score - a.score);
}
