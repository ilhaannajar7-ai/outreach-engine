/**
 * Manual lead-sourcing check.
 *
 * Calls the configured sourcing provider with real criteria and prints what
 * comes back, without creating companies or spending enrichment credits. Run
 * this after adding an Apollo key to confirm the plan allows API search and
 * that the criteria actually return companies worth contacting.
 *
 *   npx tsx --env-file=.env scripts/test-sourcing.ts
 *   npx tsx --env-file=.env scripts/test-sourcing.ts "Accounts Payable" "Bookkeeper"
 */

import { getSourcingService } from '../src/lib/providers/sourcing';

async function main() {
  const jobTitles = process.argv.slice(2);
  const criteria = {
    jobTitles: jobTitles.length ? jobTitles : ['Accounts Payable', 'Bookkeeper', 'Data Entry'],
    employeeRanges: ['11,50', '51,200'],
    limit: 5,
    page: 1,
  };

  const service = getSourcingService();
  console.log(`Provider: ${service.name}`);
  if (service.name === 'none') {
    console.error('SOURCING_PROVIDER is "none" — set it to "apollo" with APOLLO_API_KEY in .env.');
    process.exit(1);
  }

  console.log('1. Health check…');
  const health = await service.healthCheck();
  console.log('   ', health);
  if (!health.ok) {
    console.error('   ❌ Provider rejected the request. Apollo search needs a paid plan with API access.');
    process.exit(1);
  }
  console.log('   ✓ Reachable.\n');

  console.log(`2. Searching for companies hiring: ${criteria.jobTitles.join(', ')}`);
  const companies = await service.findHiringCompanies(criteria);
  console.log(`   ✓ ${companies.length} companies returned.\n`);

  for (const company of companies) {
    console.log(`   • ${company.name}  (${company.domain})`);
    console.log(`     size: ${company.sizeRange ?? '?'} · ${company.location ?? 'location unknown'}`);
    console.log(`     signal: ${company.hiringSignal ?? '(none)'}`);
    if (company.hiringSignalUrl) console.log(`     posting: ${company.hiringSignalUrl}`);
    console.log('');
  }

  if (!companies.length) {
    console.log('   No results — widen the job titles or drop the employee-range filter.');
  }
}

main().catch((e) => {
  console.error('❌ FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
