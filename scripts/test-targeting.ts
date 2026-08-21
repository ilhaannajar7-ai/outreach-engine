/**
 * Checks for contact targeting.
 *
 * The whole value of enrichment is picking the RIGHT person — a verified
 * address for the wrong role produces zero replies and drags the list down. So
 * the ranking is the part that has to be right, and it is pure logic, testable
 * without spending a Hunter credit.
 *
 *   npx tsx scripts/test-targeting.ts
 */

import { rankContacts, scoreContact, targetFilters } from '../src/lib/enrichment/targeting';
import type { FoundContact } from '../src/lib/providers/enrichment';

let failures = 0;
function assert(label: string, condition: boolean, detail?: string) {
  if (!condition) failures++;
  console.log(`  ${condition ? '✓' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const c = (jobTitle: string, seniority?: string, confidence = 90): FoundContact => ({
  email: `${jobTitle.replace(/\W+/g, '.').toLowerCase()}@acme.com`,
  fullName: 'Test Person',
  jobTitle,
  ...(seniority ? { seniority } : {}),
  confidence,
});

console.log('\nRANKING\n');

// The classic decision: a CFO should always beat an office manager and HR.
const pool: FoundContact[] = [
  c('Office Manager', 'senior'),
  c('HR Business Partner', 'senior'),
  c('Chief Financial Officer', 'executive'),
  c('Accounts Assistant', 'junior'),
  c('Marketing Coordinator', 'junior'),
];

const { best, ranked, rejected } = rankContacts(pool);
console.log('  ranking, best first:');
for (const r of [...ranked, ...rejected]) {
  console.log(`      ${String(r.targetScore).padStart(3)}  ${r.jobTitle}  (${r.reason})`);
}
console.log('');

assert('the CFO is chosen', best?.jobTitle === 'Chief Financial Officer');
assert('HR is rejected as wrong function', rejected.some((r) => r.jobTitle === 'HR Business Partner'));
assert('marketing is rejected as wrong function', rejected.some((r) => r.jobTitle === 'Marketing Coordinator'));
assert('a junior accounts assistant does not win', best?.jobTitle !== 'Accounts Assistant');

// Seniority breaks ties between similar titles.
const fmSenior = scoreContact(c('Finance Manager', 'executive'));
const fmJunior = scoreContact(c('Finance Manager', 'junior'));
assert('same title, higher seniority scores higher', fmSenior.targetScore > fmJunior.targetScore);

// A relevant finance title beats a generic manager.
const controller = scoreContact(c('Financial Controller', 'senior'));
const genericMgr = scoreContact(c('Facilities Manager', 'senior'));
assert('a finance role beats a generic manager', controller.targetScore > genericMgr.targetScore);

// An empty pool must not crash and must choose nobody.
const empty = rankContacts([]);
assert('empty pool yields no best contact', empty.best === null);

// A pool of only wrong-function people yields nobody worth emailing.
const allWrong = rankContacts([c('HR Manager', 'senior'), c('Sales Rep', 'junior'), c('IT Support')]);
assert('a pool of only wrong-function people is fully rejected', allWrong.best === null);
console.log(`      (all ${allWrong.rejected.length} rejected, as they should be)`);

console.log('\nCAMPAIGN TARGETING\n');

const defaultFilters = targetFilters(null);
assert('default titles include CFO', defaultFilters.jobTitles.includes('CFO'));

const custom = targetFilters('Head of Procurement, Supply Chain Director');
assert('a campaign role overrides the default titles', custom.jobTitles.includes('Head of Procurement'));
assert('campaign targeting keeps the seniority defaults', custom.seniorities.includes('executive'));

console.log(
  failures === 0 ? '\n✓ All targeting checks passed.\n' : `\n✘ ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
