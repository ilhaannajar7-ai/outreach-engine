/**
 * Weekly performance analysis.
 *
 * Gathers what actually happened per campaign and per strategy variant, then
 * asks the model to read it the way an analyst would: what is working, what is
 * not, and what to change. The numbers are computed here in SQL — the model is
 * given facts and asked to interpret them, never asked to produce a statistic.
 * That split matters: a model that invents a reply rate is worse than no
 * report at all.
 *
 * Significance is decided by `evaluateExperiment`, not by the model, so a
 * variant is only ever called a winner when the maths says so.
 */

import { db, sql } from '@/db';
import { settings } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getAiService } from '@/lib/providers/ai';
import { getAiConfig } from '@/lib/ai/config';
import { assertWithinBudget, recordAiUsage } from '@/lib/ai/budget';
import { evaluateExperiment, type VariantStats } from '@/lib/experiments/stats';

export const WEEKLY_INSIGHTS_KEY = 'weekly_insights_latest';

export interface CampaignPerformance {
  campaignId: string | null;
  campaignName: string;
  sent: number;
  opened: number;
  replied: number;
  interested: number;
  bounced: number;
  openRate: number;
  replyRate: number;
  interestedRate: number;
}

export interface VariantPerformance extends VariantStats {
  campaignName: string;
  replyRate: number;
  verdict: string;
  explanation: string;
}

export interface WeeklyInsights {
  generatedAt: string;
  periodDays: number;
  totals: {
    sent: number;
    opened: number;
    replied: number;
    interested: number;
    bounced: number;
    replyRate: number;
  };
  campaigns: CampaignPerformance[];
  variants: VariantPerformance[];
  /** Model-written analysis. Absent when there was too little data to bother. */
  analysis?: {
    headline: string;
    whatIsWorking: string[];
    whatIsNot: string[];
    recommendations: string[];
    confidence: string;
  };
  /** Set when the maths — not the model — identifies a winner. */
  significantWinner: { name: string; replyRate: number; explanation: string } | null;
  note: string;
}

/** Per-campaign outcomes over the window. Null campaign = unassigned leads. */
async function campaignPerformance(
  organizationId: string,
  days: number,
): Promise<CampaignPerformance[]> {
  const rows = await sql<
    {
      campaign_id: string | null;
      campaign_name: string | null;
      sent: number;
      opened: number;
      replied: number;
      interested: number;
      bounced: number;
    }[]
  >`
    SELECT c.id                                                        AS campaign_id,
           c.name                                                      AS campaign_name,
           COUNT(e.id) FILTER (WHERE e.status IN ('sent','delivered','bounced','complained'))::int AS sent,
           COUNT(e.id) FILTER (WHERE e.open_count > 0)::int            AS opened,
           COUNT(DISTINCT r.lead_id)::int                              AS replied,
           COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'interested')::int AS interested,
           COUNT(e.id) FILTER (WHERE e.status = 'bounced')::int        AS bounced
    FROM emails e
    JOIN leads l            ON l.id = e.lead_id
    LEFT JOIN campaigns c   ON c.id = l.campaign_id
    LEFT JOIN replies r     ON r.lead_id = l.id AND r.received_at >= NOW() - (${days} * INTERVAL '1 day')
    WHERE e.organization_id = ${organizationId}
      AND e.sent_at >= NOW() - (${days} * INTERVAL '1 day')
    GROUP BY c.id, c.name
    ORDER BY sent DESC
  `;

  return rows.map((r) => {
    const pct = (n: number) => (r.sent > 0 ? (n / r.sent) * 100 : 0);
    return {
      campaignId: r.campaign_id,
      campaignName: r.campaign_name ?? 'Unassigned',
      sent: r.sent,
      opened: r.opened,
      replied: r.replied,
      interested: r.interested,
      bounced: r.bounced,
      openRate: pct(r.opened),
      replyRate: pct(r.replied),
      interestedRate: pct(r.interested),
    };
  });
}

/** Per-variant outcomes, all time — an A/B test needs its full history. */
async function variantPerformance(organizationId: string): Promise<
  (VariantStats & { campaignName: string })[]
> {
  const rows = await sql<
    {
      id: string;
      name: string;
      campaign_name: string | null;
      is_control: boolean;
      sent: number;
      replied: number;
      interested: number;
    }[]
  >`
    SELECT v.id,
           v.name,
           c.name                                                       AS campaign_name,
           v.is_control,
           COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('sent','delivered','bounced','complained'))::int AS sent,
           COUNT(DISTINCT l.id) FILTER (WHERE l.replied_at IS NOT NULL)::int AS replied,
           COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'interested')::int  AS interested
    FROM strategy_variants v
    LEFT JOIN leads l     ON l.variant_id = v.id
    LEFT JOIN emails e    ON e.lead_id = l.id
    LEFT JOIN campaigns c ON c.id = v.campaign_id
    WHERE v.organization_id = ${organizationId}
    GROUP BY v.id, v.name, c.name, v.is_control
    ORDER BY v.is_control DESC, sent DESC
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isControl: r.is_control,
    sent: r.sent,
    replied: r.replied,
    interested: r.interested,
    campaignName: r.campaign_name ?? 'No campaign',
  }));
}

const SYSTEM_PROMPT = `You are an outreach performance analyst. You are given real, already-computed metrics from a cold email system. Interpret them.

RULES:
- Never invent or recompute a number. Quote only figures present in the input.
- Cold email benchmarks: reply rate 1-3% is normal, 5%+ is strong, under 1% is a problem. Open rate is unreliable (blocked and preloaded pixels both distort it) — weight replies far more heavily.
- Small samples mean nothing. Under 100 sends per arm, say so plainly rather than declaring a winner. The system's own significance test decides winners; you never override it.
- Bounce rate above 3% is urgent — list quality or verification is failing.
- Be concrete. "Variant B's opener names the role, A's does not" beats "B resonates better".
- If there is too little data to say anything useful, say exactly that. A short honest report is correct; padding is not.

Output JSON with exactly these keys:
{
  "headline": string,            // one sentence: the single most important thing this week
  "whatIsWorking": string[],     // 0-4 specific observations backed by the figures
  "whatIsNot": string[],         // 0-4 specific problems, most costly first
  "recommendations": string[],   // 0-4 concrete next actions, highest impact first
  "confidence": string           // one sentence on how much these numbers can bear
}`;

/**
 * Build the weekly report and persist it. Returns the report; never throws for
 * a missing AI budget — the numbers are still worth publishing without the
 * written analysis.
 */
export async function generateWeeklyInsights(
  organizationId: string,
  days = 7,
): Promise<WeeklyInsights> {
  const [campaigns, variantRows] = await Promise.all([
    campaignPerformance(organizationId, days),
    variantPerformance(organizationId),
  ]);

  const totals = campaigns.reduce(
    (acc, c) => ({
      sent: acc.sent + c.sent,
      opened: acc.opened + c.opened,
      replied: acc.replied + c.replied,
      interested: acc.interested + c.interested,
      bounced: acc.bounced + c.bounced,
      replyRate: 0,
    }),
    { sent: 0, opened: 0, replied: 0, interested: 0, bounced: 0, replyRate: 0 },
  );
  totals.replyRate = totals.sent > 0 ? (totals.replied / totals.sent) * 100 : 0;

  // Significance is the maths' call, not the model's.
  const readout = evaluateExperiment(variantRows);
  const variants: VariantPerformance[] = readout.variants.map((v) => ({
    id: v.id,
    name: v.name,
    isControl: v.isControl,
    sent: v.sent,
    replied: v.replied,
    interested: v.interested,
    replyRate: v.replyRate * 100,
    verdict: v.verdict,
    explanation: v.explanation,
    campaignName: variantRows.find((r) => r.id === v.id)?.campaignName ?? '',
  }));

  const report: WeeklyInsights = {
    generatedAt: new Date().toISOString(),
    periodDays: days,
    totals,
    campaigns,
    variants,
    significantWinner: readout.winner
      ? {
          name: readout.winner.name,
          replyRate: readout.winner.replyRate * 100,
          explanation: readout.winner.explanation,
        }
      : null,
    note: readout.summary,
  };

  // Nothing sent means nothing to analyse — publishing the empty shape is more
  // useful than spending a call to be told there is no data.
  if (totals.sent === 0) {
    report.analysis = {
      headline: 'No emails were sent in this period, so there is nothing to measure yet.',
      whatIsWorking: [],
      whatIsNot: [],
      recommendations: [
        'Approve drafts from the queue to start producing data.',
        'Each variant needs roughly 100 sends before any comparison is meaningful.',
      ],
      confidence: 'No data.',
    };
    await persist(organizationId, report);
    return report;
  }

  try {
    await assertWithinBudget(organizationId, 'assistant', 0.02);
    const config = await getAiConfig(organizationId, 'assistant');
    const ai = getAiService();

    const started = Date.now();
    const result = await ai.completeJson<WeeklyInsights['analysis']>(
      {
        model: config.model,
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              `Reporting period: last ${days} days.\n\n` +
              `OVERALL\n${JSON.stringify(totals, null, 2)}\n\n` +
              `BY CAMPAIGN\n${JSON.stringify(campaigns, null, 2)}\n\n` +
              `BY STRATEGY VARIANT (all time — verdicts are from the system's own significance test, do not contradict them)\n` +
              `${JSON.stringify(variants, null, 2)}\n\n` +
              `System's read on the experiment: ${readout.summary}\n` +
              `Sends per arm still recommended: ${readout.recommendedSampleSize}\n\n` +
              `Write the analysis as JSON.`,
          },
        ],
        maxTokens: 1500,
        temperature: 0.3,
        expectJson: true,
      },
      (raw) => raw as WeeklyInsights['analysis'],
    );

    report.analysis = result.data;

    await recordAiUsage({
      organizationId,
      operation: 'assistant',
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
      durationMs: Date.now() - started,
      success: true,
    });
  } catch (error) {
    // The figures are the substance; the write-up is a bonus. A budget stop or
    // a provider blip must not cost you the report.
    report.analysis = {
      headline: 'Metrics below are current; the written analysis could not be produced.',
      whatIsWorking: [],
      whatIsNot: [],
      recommendations: [],
      confidence: error instanceof Error ? error.message : 'AI analysis unavailable.',
    };
  }

  await persist(organizationId, report);
  return report;
}

async function persist(organizationId: string, report: WeeklyInsights): Promise<void> {
  await db
    .insert(settings)
    .values({
      organizationId,
      key: WEEKLY_INSIGHTS_KEY,
      value: report as never,
      valueType: 'json',
      description: 'Most recent weekly performance analysis',
    })
    .onConflictDoUpdate({
      target: [settings.organizationId, settings.key],
      set: { value: report as never, updatedAt: new Date() },
    });
}

/** The stored report, or null if one has never been generated. */
export async function getStoredWeeklyInsights(
  organizationId: string,
): Promise<WeeklyInsights | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.organizationId, organizationId), eq(settings.key, WEEKLY_INSIGHTS_KEY)))
    .limit(1);

  return (row?.value as WeeklyInsights | undefined) ?? null;
}
