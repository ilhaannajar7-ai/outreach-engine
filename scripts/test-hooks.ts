/**
 * Hook-quality checks.
 *
 * These are the cases the scorer exists to separate. If a change to the
 * weights lets a generic hook through — or starts rejecting a genuinely
 * specific one — this fails loudly rather than silently degrading every email
 * the system writes.
 *
 *   npx tsx scripts/test-hooks.ts
 */

import { assessHook, assessResearch, HOOK_QUALITY_THRESHOLD } from '../src/lib/ai/hook-quality';

interface Case {
  label: string;
  observation: string;
  inference?: string;
  shouldPass: boolean;
}

const CASES: Case[] = [
  // --- Should be REJECTED: true of almost any company ---------------------
  {
    label: 'vague growth',
    observation: 'The company is growing and looking to scale their operations',
    inference: 'They probably need more support',
    shouldPass: false,
  },
  {
    label: 'peer comparison',
    observation: 'Companies like theirs often struggle with back-office costs',
    inference: 'Outsourcing could help them',
    shouldPass: false,
  },
  {
    label: 'marketing adjective',
    observation: 'They are a leading provider in their industry',
    inference: 'They value quality',
    shouldPass: false,
  },
  {
    label: 'discovery opener, no facts',
    observation: 'I came across their company and noticed they are hiring',
    inference: 'They are expanding the team',
    shouldPass: false,
  },
  {
    label: 'vague intent',
    observation: 'They are looking to improve efficiency across the business',
    inference: 'A partner could help',
    shouldPass: false,
  },

  // --- Should PASS: could only be true of this company --------------------
  {
    label: 'count + role + time',
    observation: 'Posted three accounts receivable clerk roles and a finance assistant in the last 30 days',
    inference: 'Invoice volume has outgrown the finance team rather than this being planned expansion',
    shouldPass: true,
  },
  {
    label: 'repeat posting',
    observation: 'Has advertised for AR clerks twice since March',
    inference: 'The first hire either fell through or was not enough for the workload',
    shouldPass: true,
  },
  {
    label: 'count + role, headcount context',
    observation: 'Hiring 4 medical billing coordinators at a company of around 200 staff',
    inference: 'Billing operations are scaling faster than the admin function supporting them',
    shouldPass: true,
  },
  {
    label: 'single role, dated',
    observation: 'Advertised for a payroll specialist and 4 data entry staff last month',
    inference: 'Payroll and data processing are both under strain at the same time',
    shouldPass: true,
  },
];

let failures = 0;

console.log(`\nHook quality — threshold ${HOOK_QUALITY_THRESHOLD}/100\n`);
console.log('  RESULT  SCORE  CASE');
console.log('  ──────  ─────  ────────────────────────────────────────');

for (const testCase of CASES) {
  const result = assessHook(testCase);
  const ok = result.isSpecific === testCase.shouldPass;
  if (!ok) failures++;

  const verdict = result.isSpecific ? 'pass' : 'reject';
  const expected = testCase.shouldPass ? 'pass' : 'reject';

  console.log(
    `  ${ok ? '  ✓   ' : '  ✘   '}  ${String(result.score).padStart(3)}    ` +
      `${testCase.label}${ok ? '' : `  (got ${verdict}, expected ${expected})`}`,
  );

  if (!ok) {
    for (const note of result.notes) console.log(`               → ${note}`);
  }
}

// A brief where nothing is specific must be reported as unusable, so the
// research job can stop rather than generating an email from filler.
const weakBrief = assessResearch([
  { observation: 'They are growing quickly', inference: 'They need help' },
  { observation: 'Many companies in this space outsource', inference: 'So could they' },
]);

const strongBrief = assessResearch([
  { observation: 'They are growing quickly', inference: 'They need help' },
  {
    observation: 'Posted three AR clerk roles in the last 30 days',
    inference: 'Invoice volume outgrew the finance team',
  },
]);

console.log('\nBrief-level assessment');
console.log(`  weak brief   → usable: ${weakBrief.isUsable}  (expected false)`);
console.log(`  strong brief → usable: ${strongBrief.isUsable}  (expected true)`);

if (weakBrief.isUsable) failures++;
if (!strongBrief.isUsable) failures++;

console.log(
  failures === 0
    ? '\n✓ All hook-quality checks passed.\n'
    : `\n✘ ${failures} check(s) failed.\n`,
);

process.exit(failures === 0 ? 0 : 1);
