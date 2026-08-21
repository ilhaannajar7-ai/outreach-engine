/**
 * Exercise every assistant tool against the real database.
 *
 * The tools are the half of the assistant that can be verified without a model:
 * if these return correct data and the write gate holds, the only remaining
 * variable is how well Claude phrases the answer.
 *
 * Read tools are executed. Write tools are NOT — this asserts they are declared
 * correctly and refuses to run them, which is the same guarantee the loop makes.
 *
 *   npx tsx scripts/test-assistant-tools.ts
 */

import 'dotenv/config';
import { db } from '../src/db';
import { organizations, users } from '../src/db/schema';
import { ASSISTANT_TOOLS, toolDefinitions, type AssistantContext } from '../src/lib/assistant/tools';
import { executeConfirmedAction } from '../src/lib/assistant/run';

function preview(value: unknown, max = 240): string {
  const text = JSON.stringify(value);
  if (!text) return String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function main() {
  const [org] = await db.select().from(organizations).limit(1);
  const [user] = await db.select().from(users).limit(1);

  if (!org || !user) {
    console.error('No organization or user found. Run the seed first.');
    process.exit(1);
  }

  const ctx: AssistantContext = {
    organizationId: org.id,
    userId: user.id,
    canWrite: true,
  };

  let failures = 0;

  // --- Read tools: run them all ------------------------------------------
  console.log('\nREAD TOOLS (executed)\n');

  for (const tool of ASSISTANT_TOOLS.filter((t) => t.access === 'read')) {
    // Tools with required arguments get a realistic value; the rest run bare.
    const input: Record<string, unknown> =
      tool.name === 'inspect_lead' ? { companyName: 'Northwind' } : {};

    try {
      const result = await tool.run(input, ctx);
      console.log(`  ✓ ${tool.name}`);
      console.log(`      ${preview(result)}\n`);
    } catch (error) {
      failures++;
      console.log(`  ✘ ${tool.name} — ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // --- Write tools: declared, but never executed here ---------------------
  console.log('WRITE TOOLS (declared, not executed)\n');

  for (const tool of ASSISTANT_TOOLS.filter((t) => t.access === 'write')) {
    if (!tool.summarize) {
      failures++;
      console.log(`  ✘ ${tool.name} — write tool has no summarize(), so nothing describes the`);
      console.log('       change on the confirmation card\n');
      continue;
    }

    const sample: Record<string, unknown> = {
      set_ai_model: { operation: 'email_generation', model: 'claude-haiku-4-5' },
      set_ai_budget: { warnAtUsd: 16, stopAtUsd: 20 },
      retry_failed_jobs: { jobType: 'research_company' },
      set_campaign_status: { campaignName: 'Q3', status: 'paused' },
      queue_research: { limit: 5 },
      recheck_dns: { domain: 'yoursolutions.io' },
    }[tool.name] ?? {};

    console.log(`  ✓ ${tool.name}`);
    console.log(`      confirmation reads: "${tool.summarize(sample)}"\n`);
  }

  // --- The write gate ------------------------------------------------------
  console.log('WRITE GATE\n');

  // A viewer must not be able to execute a write even with a valid tool name.
  const asViewer = await executeConfirmedAction({
    ctx: { ...ctx, canWrite: false },
    toolName: 'set_ai_model',
    input: { operation: 'research', model: 'claude-opus-5' },
  });

  if (asViewer.ok) {
    failures++;
    console.log('  ✘ a read-only role was allowed to execute a write tool');
  } else {
    console.log(`  ✓ read-only role refused: "${asViewer.error}"`);
  }

  // Read tools must not be routable through the confirmation endpoint, or the
  // endpoint becomes a way to run anything by name.
  const readViaConfirm = await executeConfirmedAction({
    ctx,
    toolName: 'get_status',
    input: {},
  });

  if (readViaConfirm.ok) {
    failures++;
    console.log('  ✘ a read tool executed through the confirm endpoint');
  } else {
    console.log(`  ✓ read tool refused by confirm endpoint: "${readViaConfirm.error}"`);
  }

  const unknownTool = await executeConfirmedAction({
    ctx,
    toolName: 'delete_everything',
    input: {},
  });

  if (unknownTool.ok) {
    failures++;
    console.log('  ✘ an unknown tool name executed');
  } else {
    console.log(`  ✓ unknown tool refused: "${unknownTool.error}"`);
  }

  // --- Prohibited capabilities --------------------------------------------
  console.log('\nPROHIBITED CAPABILITIES\n');

  // Matched as a leading verb, not a substring — `get_sending_health` reports
  // on sending, it does not send.
  const FORBIDDEN_VERB = /^(send|approve|reject|delete|remove|destroy|purge)_/;
  const offenders = ASSISTANT_TOOLS.filter((tool) => FORBIDDEN_VERB.test(tool.name.toLowerCase()));

  if (offenders.length > 0) {
    failures++;
    console.log(`  ✘ tools exist that should not: ${offenders.map((t) => t.name).join(', ')}`);
  } else {
    console.log('  ✓ no tool sends, approves, or deletes anything');
  }

  // The specific capabilities that must never be reachable by name.
  const MUST_NOT_EXIST = [
    'send_email',
    'approve_email',
    'bulk_approve',
    'delete_lead',
    'disable_budget',
  ];
  const found = MUST_NOT_EXIST.filter((name) => ASSISTANT_TOOLS.some((t) => t.name === name));

  if (found.length > 0) {
    failures++;
    console.log(`  ✘ forbidden tool present: ${found.join(', ')}`);
  } else {
    console.log(`  ✓ none of the ${MUST_NOT_EXIST.length} explicitly forbidden tools exist`);
  }

  // A viewer must not even be offered the write tools.
  const viewerTools = toolDefinitions(false);
  const writeNames = new Set(
    ASSISTANT_TOOLS.filter((t) => t.access === 'write').map((t) => t.name),
  );
  const leaked = viewerTools.filter((t) => writeNames.has(t.name));

  if (leaked.length > 0) {
    failures++;
    console.log(`  ✘ write tools offered to a viewer: ${leaked.map((t) => t.name).join(', ')}`);
  } else {
    console.log(
      `  ✓ viewer is offered ${viewerTools.length} read tools and none of the ${writeNames.size} write tools`,
    );
  }

  console.log(
    failures === 0
      ? `\n✓ All assistant tool checks passed (${ASSISTANT_TOOLS.length} tools).\n`
      : `\n✘ ${failures} check(s) failed.\n`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Test run failed:', error);
  process.exit(1);
});
