/**
 * End-to-end checks for variant assignment and results.
 *
 * Assignment is the part most likely to be subtly wrong — a split that looks
 * random but is not would bias the whole experiment while every number on the
 * dashboard still looked plausible.
 *
 * Creates its own variants, runs the checks, then removes them.
 *
 *   npx tsx scripts/test-experiments.ts
 */

import 'dotenv/config';
import { db } from '../src/db';
import { organizations, strategyVariants, leads } from '../src/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import {
  assignVariant,
  variantPromptAdditions,
  getExperimentResults,
  promoteVariant,
} from '../src/lib/experiments';

let failures = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (!condition) failures++;
  console.log(`  ${condition ? '✓' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) {
    console.error('No organization found. Run the seed first.');
    process.exit(1);
  }

  const orgId = org.id;
  const created: string[] = [];

  // Isolate from any real variants by scoping to a throwaway campaign id.
  console.log('\nASSIGNMENT\n');

  // One variant is not an experiment.
  const [solo] = await db
    .insert(strategyVariants)
    .values({
      organizationId: orgId,
      campaignId: null,
      name: '__test_control',
      isControl: true,
      weight: 1,
      angleInstructions: 'Lead with cost.',
      ctaStyle: 'call',
      targetLength: 'short',
    })
    .returning();
  created.push(solo!.id);

  const noneYet = await assignVariant({ organizationId: orgId, campaignId: null });
  assert(
    'a single variant yields no assignment (nothing to compare against)',
    noneYet === null,
  );

  const [second] = await db
    .insert(strategyVariants)
    .values({
      organizationId: orgId,
      campaignId: null,
      name: '__test_variant_b',
      isControl: false,
      weight: 1,
      angleInstructions: 'Lead with speed to productivity.',
      ctaStyle: 'question',
    })
    .returning();
  created.push(second!.id);

  const assigned = await assignVariant({ organizationId: orgId, campaignId: null });
  assert('two variants produce an assignment', assigned !== null);

  // Distribution over an even split.
  const counts = new Map<string, number>();
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const pick = await assignVariant({ organizationId: orgId, campaignId: null });
    if (pick) counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1);
  }

  const a = counts.get(solo!.id) ?? 0;
  const b = counts.get(second!.id) ?? 0;
  const skew = Math.abs(a - b) / N;

  console.log(`      even weights over ${N} draws: ${a} / ${b} (skew ${(skew * 100).toFixed(1)}%)`);
  assert('an even split stays within 5% of 50/50', skew < 0.05);
  assert('both arms receive leads', a > 0 && b > 0);

  // Weighted split: 3:1 should land near 75/25.
  await db.update(strategyVariants).set({ weight: 3 }).where(eq(strategyVariants.id, solo!.id));

  const weighted = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const pick = await assignVariant({ organizationId: orgId, campaignId: null });
    if (pick) weighted.set(pick.id, (weighted.get(pick.id) ?? 0) + 1);
  }

  const heavyShare = (weighted.get(solo!.id) ?? 0) / N;
  console.log(`      3:1 weights over ${N} draws: ${(heavyShare * 100).toFixed(1)}% to the heavy arm`);
  assert('a 3:1 weight lands near 75%', Math.abs(heavyShare - 0.75) < 0.04);

  await db.update(strategyVariants).set({ weight: 1 }).where(eq(strategyVariants.id, solo!.id));

  // An inactive variant must stop receiving new leads.
  await db.update(strategyVariants).set({ isActive: false }).where(eq(strategyVariants.id, second!.id));
  const afterPause = await assignVariant({ organizationId: orgId, campaignId: null });
  assert(
    'pausing an arm drops the split back to no experiment',
    afterPause === null,
    'only one active variant remains',
  );
  await db.update(strategyVariants).set({ isActive: true }).where(eq(strategyVariants.id, second!.id));

  // --- Prompt construction ------------------------------------------------
  console.log('\nPROMPT INSTRUCTIONS\n');

  const withNothing = variantPromptAdditions(null);
  assert('no variant produces no prompt text', withNothing === '');

  const text = variantPromptAdditions({
    angleInstructions: 'Lead with cost.',
    ctaStyle: 'question',
    targetLength: 'short',
  });
  assert('angle text is included', text.includes('Lead with cost.'));
  assert('question CTA forbids asking for a call', text.includes('Do not ask for a call'));
  assert('short length sets a word cap', text.includes('under 70 words'));
  console.log(`\n${text.split('\n').map((l) => `      ${l}`).join('\n')}\n`);

  // --- Results ------------------------------------------------------------
  console.log('RESULTS\n');

  const results = await getExperimentResults({ organizationId: orgId, campaignId: null });
  assert('both test variants appear in the readout', results.variants.length >= 2);
  assert('a control is identified', results.control !== null);
  assert('no winner is declared with zero sends', results.winner === null);
  console.log(`      "${results.summary}"`);

  // --- Promotion ----------------------------------------------------------
  console.log('\nPROMOTION\n');

  const promoted = await promoteVariant({ organizationId: orgId, variantId: second!.id });
  assert('promoting a non-control succeeds', 'promoted' in promoted);

  // isNull, not eq(col, null) — the latter compiles to `= NULL`, which matches
  // no rows and would make this check silently pass on an empty result.
  const after = await db
    .select({ id: strategyVariants.id, isControl: strategyVariants.isControl })
    .from(strategyVariants)
    .where(and(eq(strategyVariants.organizationId, orgId), isNull(strategyVariants.campaignId)));

  const controls = after.filter((v) => v.isControl);
  assert('exactly one control remains after promotion', controls.length === 1);
  assert('the promoted variant is now the control', controls[0]?.id === second!.id);

  const alreadyControl = await promoteVariant({ organizationId: orgId, variantId: second!.id });
  assert('promoting the existing control is refused', 'error' in alreadyControl);

  // --- Cleanup ------------------------------------------------------------
  await db.update(leads).set({ variantId: null }).where(eq(leads.organizationId, orgId));
  for (const id of created) {
    await db.delete(strategyVariants).where(eq(strategyVariants.id, id));
  }
  console.log('\n  (test variants removed)');

  console.log(
    failures === 0 ? '\n✓ All experiment checks passed.\n' : `\n✘ ${failures} check(s) failed.\n`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Test run failed:', error);
  process.exit(1);
});
