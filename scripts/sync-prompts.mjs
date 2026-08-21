/**
 * Publish the current file-default prompts as new active versions.
 *
 * Prompts live in the database so dashboard edits persist and win over the
 * file. The trade-off is that shipping an improved default (in
 * src/lib/ai/prompts.ts) does NOT reach an existing install on its own — the
 * seed only inserts version 1 and never overwrites.
 *
 * This script closes that gap the same way the dashboard's "save prompt" does:
 * for each operation whose active prompt differs from the file default, it
 * writes a NEW version and activates it. The previous version stays in history
 * and is one click to revert, so nothing is lost and a hand-edited prompt can
 * be recovered if this overwrites it.
 *
 * It is a deliberate action, never automatic — run it when adopting new
 * defaults:
 *
 *   node scripts/sync-prompts.mjs            # all organizations
 *   node scripts/sync-prompts.mjs --dry-run  # show what would change
 */

import 'dotenv/config';
import postgres from 'postgres';
import { DEFAULT_PROMPTS } from '../src/lib/ai/prompts.ts';

const dryRun = process.argv.includes('--dry-run');
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

const orgs = await sql`SELECT id, name FROM organizations`;
let changed = 0;
let unchanged = 0;

for (const org of orgs) {
  for (const [operation, def] of Object.entries(DEFAULT_PROMPTS)) {
    const [active] = await sql`
      SELECT version, system_prompt, user_prompt_template
      FROM ai_prompts
      WHERE organization_id = ${org.id} AND operation = ${operation} AND is_active = true
      ORDER BY version DESC
      LIMIT 1`;

    // Byte-identical to the file default → nothing to publish.
    if (
      active &&
      active.system_prompt === def.systemPrompt &&
      active.user_prompt_template === def.userPromptTemplate
    ) {
      unchanged++;
      continue;
    }

    const [{ max }] = await sql`
      SELECT COALESCE(MAX(version), 0) AS max FROM ai_prompts
      WHERE organization_id = ${org.id} AND operation = ${operation}`;
    const nextVersion = Number(max) + 1;

    console.log(
      `  ${dryRun ? 'would update' : 'updating'}  ${org.name} · ${operation} ` +
        `(v${active?.version ?? '—'} → v${nextVersion})`,
    );

    if (!dryRun) {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE ai_prompts SET is_active = false
          WHERE organization_id = ${org.id} AND operation = ${operation}`;
        await tx`
          INSERT INTO ai_prompts (organization_id, operation, version, system_prompt,
            user_prompt_template, is_active)
          VALUES (${org.id}, ${operation}, ${nextVersion}, ${def.systemPrompt},
            ${def.userPromptTemplate}, true)`;
      });
    }

    changed++;
  }
}

console.log(
  `\n${dryRun ? '(dry run) ' : ''}${changed} prompt(s) ${dryRun ? 'would be' : ''} updated, ${unchanged} already current.`,
);
if (changed > 0 && !dryRun) {
  console.log('Applies to the next call. Cached research is not re-run — force it per lead if needed.');
}

await sql.end();
process.exit(0);
