/**
 * Strategy experiments: assignment and results.
 *
 * Results are computed from leads and emails on every read rather than kept in
 * counter columns. A counter that drifts by a few percent would quietly change
 * which variant appears to win, and nothing about the dashboard would reveal it.
 */

import { db } from '@/db';
import { strategyVariants, leads, emails } from '@/db/schema';
import { and, eq, inArray, sql as dsql, isNotNull } from 'drizzle-orm';
import { evaluateExperiment, type VariantStats, type ExperimentReadout } from './stats';

export * from './stats';

export interface AssignedVariant {
  id: string;
  name: string;
  angleInstructions: string | null;
  ctaStyle: string | null;
  targetLength: string | null;
}

/**
 * Pick a variant for a new lead, weighted.
 *
 * Returns null when a campaign has fewer than two active variants — there is no
 * experiment to run, and tagging every lead with a lone "variant" would imply
 * one exists.
 */
export async function assignVariant(params: {
  organizationId: string;
  campaignId: string | null;
}): Promise<AssignedVariant | null> {
  const conditions = [
    eq(strategyVariants.organizationId, params.organizationId),
    eq(strategyVariants.isActive, true),
  ];

  conditions.push(
    params.campaignId
      ? eq(strategyVariants.campaignId, params.campaignId)
      : dsql`${strategyVariants.campaignId} IS NULL`,
  );

  const active = await db
    .select({
      id: strategyVariants.id,
      name: strategyVariants.name,
      weight: strategyVariants.weight,
      angleInstructions: strategyVariants.angleInstructions,
      ctaStyle: strategyVariants.ctaStyle,
      targetLength: strategyVariants.targetLength,
    })
    .from(strategyVariants)
    .where(and(...conditions));

  if (active.length < 2) return null;

  const totalWeight = active.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (totalWeight <= 0) return null;

  // Weighted pick. Random rather than round-robin: leads are imported in
  // batches that are often sorted by industry or size, and round-robin over a
  // sorted batch correlates the arm with the ordering.
  let roll = Math.random() * totalWeight;
  for (const variant of active) {
    roll -= Math.max(0, variant.weight);
    if (roll <= 0) return variant;
  }

  return active[active.length - 1]!;
}

/**
 * Live results for one campaign's experiment.
 *
 * "Sent" counts leads that actually received something, not leads assigned —
 * an assigned lead whose email is still awaiting approval has had no chance to
 * reply, and counting it drags the rate down for whichever arm happens to have
 * more drafts queued.
 */
export async function getExperimentResults(params: {
  organizationId: string;
  campaignId: string | null;
}): Promise<ExperimentReadout & { variantDetails: VariantDetail[] }> {
  const conditions = [eq(strategyVariants.organizationId, params.organizationId)];
  conditions.push(
    params.campaignId
      ? eq(strategyVariants.campaignId, params.campaignId)
      : dsql`${strategyVariants.campaignId} IS NULL`,
  );

  const variants = await db
    .select()
    .from(strategyVariants)
    .where(and(...conditions))
    .orderBy(dsql`${strategyVariants.isControl} DESC`, strategyVariants.createdAt);

  if (variants.length === 0) {
    return {
      ...evaluateExperiment([]),
      variantDetails: [],
    };
  }

  const variantIds = variants.map((v) => v.id);

  // One grouped query rather than per-variant round trips.
  const stats = await db
    .select({
      variantId: leads.variantId,
      assigned: dsql<number>`COUNT(DISTINCT ${leads.id})::int`,
      sent: dsql<number>`COUNT(DISTINCT ${leads.id}) FILTER (WHERE ${leads.firstContactedAt} IS NOT NULL)::int`,
      replied: dsql<number>`COUNT(DISTINCT ${leads.id}) FILTER (WHERE ${leads.repliedAt} IS NOT NULL)::int`,
      interested: dsql<number>`COUNT(DISTINCT ${leads.id}) FILTER (WHERE ${leads.status} = 'interested')::int`,
    })
    .from(leads)
    .where(and(eq(leads.organizationId, params.organizationId), inArray(leads.variantId, variantIds)))
    .groupBy(leads.variantId);

  // Opens are reported but never used to decide a winner: Apple and Gmail
  // pre-fetch images, which inflates opens unpredictably per recipient.
  const opens = await db
    .select({
      variantId: leads.variantId,
      opened: dsql<number>`COUNT(DISTINCT ${leads.id}) FILTER (WHERE ${emails.openCount} > 0)::int`,
    })
    .from(emails)
    .innerJoin(leads, eq(emails.leadId, leads.id))
    .where(and(eq(emails.organizationId, params.organizationId), inArray(leads.variantId, variantIds)))
    .groupBy(leads.variantId);

  const statsById = new Map(stats.map((s) => [s.variantId, s]));
  const opensById = new Map(opens.map((o) => [o.variantId, o.opened]));

  const variantStats: VariantStats[] = variants.map((v) => {
    const s = statsById.get(v.id);
    return {
      id: v.id,
      name: v.name,
      isControl: v.isControl,
      sent: s?.sent ?? 0,
      replied: s?.replied ?? 0,
      interested: s?.interested ?? 0,
    };
  });

  const readout = evaluateExperiment(variantStats);

  const variantDetails: VariantDetail[] = variants.map((v) => {
    const s = statsById.get(v.id);
    return {
      id: v.id,
      name: v.name,
      description: v.description,
      isControl: v.isControl,
      isActive: v.isActive,
      weight: v.weight,
      angleInstructions: v.angleInstructions,
      ctaStyle: v.ctaStyle,
      targetLength: v.targetLength,
      promotedAt: v.promotedAt?.toISOString() ?? null,
      assigned: s?.assigned ?? 0,
      opened: opensById.get(v.id) ?? 0,
    };
  });

  return { ...readout, variantDetails };
}

export interface VariantDetail {
  id: string;
  name: string;
  description: string | null;
  isControl: boolean;
  isActive: boolean;
  weight: number;
  angleInstructions: string | null;
  ctaStyle: string | null;
  targetLength: string | null;
  promotedAt: string | null;
  assigned: number;
  opened: number;
}

/**
 * Turn a variant's settings into prompt text.
 *
 * Returns '' for a lead with no variant, so email generation is byte-identical
 * to how it behaved before experiments existed.
 */
export function variantPromptAdditions(variant: {
  angleInstructions?: string | null;
  ctaStyle?: string | null;
  targetLength?: string | null;
} | null): string {
  if (!variant) return '';

  const lines: string[] = [];
  if (variant.angleInstructions?.trim()) lines.push(variant.angleInstructions.trim());

  if (variant.ctaStyle === 'call') {
    lines.push('End by asking for a short call.');
  } else if (variant.ctaStyle === 'question') {
    lines.push(
      'End with a single easy question about how they handle this today. Do not ask for a call.',
    );
  } else if (variant.ctaStyle === 'resource') {
    lines.push('End by offering to send something concrete — a one-page breakdown or example.');
  }

  if (variant.targetLength === 'short') {
    lines.push('Keep the body under 70 words.');
  } else if (variant.targetLength === 'standard') {
    lines.push('Keep the body between 90 and 130 words.');
  }

  return lines.length > 0 ? `Strategy for this lead:\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}

/**
 * Promote a variant to control.
 *
 * The old control stays active rather than being switched off — an experiment
 * with nothing to measure against is not an experiment, and the previous
 * baseline is the most meaningful comparison for whatever is tested next.
 */
export async function promoteVariant(params: {
  organizationId: string;
  variantId: string;
}): Promise<{ promoted: string } | { error: string }> {
  const [variant] = await db
    .select()
    .from(strategyVariants)
    .where(
      and(
        eq(strategyVariants.id, params.variantId),
        eq(strategyVariants.organizationId, params.organizationId),
      ),
    )
    .limit(1);

  if (!variant) return { error: 'Variant not found.' };
  if (variant.isControl) return { error: 'That variant is already the control.' };

  const scope = variant.campaignId
    ? eq(strategyVariants.campaignId, variant.campaignId)
    : dsql`${strategyVariants.campaignId} IS NULL`;

  await db
    .update(strategyVariants)
    .set({ isControl: false, updatedAt: new Date() })
    .where(and(eq(strategyVariants.organizationId, params.organizationId), scope));

  await db
    .update(strategyVariants)
    .set({ isControl: true, promotedAt: new Date(), updatedAt: new Date() })
    .where(eq(strategyVariants.id, params.variantId));

  return { promoted: variant.name };
}

/** Count leads already assigned, so the UI can warn before deactivating an arm. */
export async function countAssignedLeads(variantId: string): Promise<number> {
  const [row] = await db
    .select({ count: dsql<number>`COUNT(*)::int` })
    .from(leads)
    .where(and(eq(leads.variantId, variantId), isNotNull(leads.variantId)));

  return row?.count ?? 0;
}

export type { VariantStats };
