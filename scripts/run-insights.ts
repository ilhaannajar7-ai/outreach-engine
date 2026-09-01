/**
 * Generate the weekly performance report now, outside Monday's schedule.
 *
 * Useful for checking the report reads sensibly after changing prompts or
 * variants, and for producing a first report before the first Monday.
 *
 *   npx tsx scripts/run-insights.ts            # every organization
 *   npx tsx scripts/run-insights.ts <orgId>    # one organization
 */

import 'dotenv/config';
import { db, sql } from '../src/db';
import { organizations } from '../src/db/schema';
import { generateWeeklyInsights } from '../src/lib/insights/weekly';

const only = process.argv[2];

async function main(): Promise<void> {
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations);
  const targets = only ? orgs.filter((o) => o.id === only) : orgs;

  if (targets.length === 0) {
    console.error(only ? `No organization with id ${only}` : 'No organizations found.');
    process.exit(1);
  }

  for (const org of targets) {
    process.stdout.write(`\n${org.name}\n`);
    const report = await generateWeeklyInsights(org.id, 7);

    const t = report.totals;
    console.log(
      `  last ${report.periodDays}d — sent ${t.sent}, opened ${t.opened}, replied ${t.replied} ` +
        `(${t.replyRate.toFixed(1)}%), bounced ${t.bounced}`,
    );
    console.log(`  campaigns: ${report.campaigns.length} · variants: ${report.variants.length}`);
    console.log(`  significance: ${report.note}`);

    if (report.analysis) {
      console.log(`\n  ${report.analysis.headline}`);
      for (const [label, items] of [
        ['working', report.analysis.whatIsWorking],
        ['not working', report.analysis.whatIsNot],
        ['recommended', report.analysis.recommendations],
      ] as const) {
        for (const item of items) console.log(`    [${label}] ${item}`);
      }
      console.log(`  confidence: ${report.analysis.confidence}`);
    }
  }

  console.log('\nSaved. View it at /insights.');
  await sql.end({ timeout: 5 });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
