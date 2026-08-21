/**
 * Checks for the significance maths.
 *
 * Expected z and p values here are computed independently from the standard
 * two-proportion formula, not read back out of the implementation — otherwise
 * the test would only prove the code agrees with itself.
 *
 *   npx tsx scripts/test-stats.ts
 */

import {
  compareProportions,
  requiredSampleSize,
  evaluateExperiment,
  type VariantStats,
} from '../src/lib/experiments/stats';

let failures = 0;

function check(label: string, actual: number, expected: number, tolerance: number) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  console.log(
    `  ${ok ? '✓' : '✘'} ${label.padEnd(46)} got ${actual.toFixed(4)}  expected ~${expected.toFixed(4)}`,
  );
}

function assert(label: string, condition: boolean) {
  if (!condition) failures++;
  console.log(`  ${condition ? '✓' : '✘'} ${label}`);
}

console.log('\nTWO-PROPORTION Z-TEST\n');

// 5% vs 10% on 1000 each. Hand-computed:
//   pooled = 150/2000 = 0.075
//   se     = sqrt(0.075 * 0.925 * 0.002) = 0.0117792
//   z      = 0.05 / 0.0117792 = 4.2448
const big = compareProportions(
  { successes: 50, trials: 1000 },
  { successes: 100, trials: 1000 },
);
check('large real effect: z', big.zScore, 4.2448, 0.01);
check('large real effect: p', big.pValue, 0.0000219, 0.0001);
assert('large real effect is significant', big.isSignificant);
check('large real effect: lift', big.lift, 1.0, 0.001);

// 5% vs 6% on 100 each. Hand-computed:
//   pooled = 11/200 = 0.055
//   se     = sqrt(0.055 * 0.945 * 0.02) = 0.0322413
//   z      = 0.01 / 0.0322413 = 0.3102
const small = compareProportions(
  { successes: 5, trials: 100 },
  { successes: 6, trials: 100 },
);
check('small noisy difference: z', small.zScore, 0.3102, 0.01);
check('small noisy difference: p', small.pValue, 0.7564, 0.01);
assert('small noisy difference is NOT significant', !small.isSignificant);

const identical = compareProportions(
  { successes: 30, trials: 600 },
  { successes: 30, trials: 600 },
);
check('identical arms: z', identical.zScore, 0, 0.0001);
check('identical arms: p', identical.pValue, 1, 0.0001);
assert('identical arms are not significant', !identical.isSignificant);

const empty = compareProportions({ successes: 0, trials: 0 }, { successes: 0, trials: 0 });
assert('empty arms do not crash and are not significant', !empty.isSignificant && empty.pValue === 1);

const allZero = compareProportions({ successes: 0, trials: 50 }, { successes: 0, trials: 50 });
assert('zero successes both sides is not significant', !allZero.isSignificant);

console.log('\nSAMPLE SIZE\n');

// At a 3% baseline, detecting a 30% relative lift (3% -> 3.9%) needs a few
// thousand per arm. The exact figure matters less than the order of magnitude.
const n = requiredSampleSize(0.03, 0.3);
console.log(`  3% baseline, detect +30%  →  ${n.toLocaleString()} sends per arm`);
assert('required sample is in the thousands, not the dozens', n > 2000 && n < 12000);

const nBigLift = requiredSampleSize(0.03, 1.0);
console.log(`  3% baseline, detect +100% →  ${nBigLift.toLocaleString()} sends per arm`);
assert('a bigger effect needs a smaller sample', nBigLift < n);

console.log('\nEXPERIMENT READOUT\n');

// Under-powered: a variant well ahead on tiny numbers must NOT be called.
const early: VariantStats[] = [
  { id: 'a', name: 'Control', isControl: true, sent: 40, replied: 1, interested: 0 },
  { id: 'b', name: 'Cost angle', isControl: false, sent: 40, replied: 4, interested: 2 },
];
const earlyRead = evaluateExperiment(early);
assert('4x ahead on 40 sends is reported as insufficient data', earlyRead.variants[1]!.verdict === 'insufficient_data');
assert('no winner declared on 40 sends', earlyRead.winner === null);
console.log(`      "${earlyRead.summary}"`);

// Powered and genuinely better.
const mature: VariantStats[] = [
  { id: 'a', name: 'Control', isControl: true, sent: 1000, replied: 30, interested: 12 },
  { id: 'b', name: 'Cost angle', isControl: false, sent: 1000, replied: 70, interested: 30 },
];
const matureRead = evaluateExperiment(mature);
assert('a real effect on 1000 sends is called as winning', matureRead.variants[1]!.verdict === 'winning');
assert('winner is set', matureRead.winner?.id === 'b');
console.log(`      "${matureRead.summary}"`);

// Powered but no real difference.
const flat: VariantStats[] = [
  { id: 'a', name: 'Control', isControl: true, sent: 800, replied: 32, interested: 10 },
  { id: 'b', name: 'Reworded', isControl: false, sent: 800, replied: 35, interested: 11 },
];
const flatRead = evaluateExperiment(flat);
assert('a marginal difference on 800 sends is not called a win', flatRead.variants[1]!.verdict === 'no_difference');
assert('no winner when nothing separates', flatRead.winner === null);

// Bonferroni: more arms must raise the bar for each.
const twoArm = evaluateExperiment(mature);
const fourArm = evaluateExperiment([
  ...mature,
  { id: 'c', name: 'Third', isControl: false, sent: 1000, replied: 33, interested: 12 },
  { id: 'd', name: 'Fourth', isControl: false, sent: 1000, replied: 31, interested: 11 },
]);
console.log(`\n  alpha with 1 comparison : ${twoArm.alpha.toFixed(4)}`);
console.log(`  alpha with 3 comparisons: ${fourArm.alpha.toFixed(4)}`);
assert('alpha tightens as arms are added', fourArm.alpha < twoArm.alpha);

// A losing variant must be named as losing, not quietly ignored.
const losing: VariantStats[] = [
  { id: 'a', name: 'Control', isControl: true, sent: 1000, replied: 70, interested: 30 },
  { id: 'b', name: 'Bad idea', isControl: false, sent: 1000, replied: 25, interested: 8 },
];
const losingRead = evaluateExperiment(losing);
assert('a significantly worse variant is reported as losing', losingRead.variants[1]!.verdict === 'losing');

console.log(
  failures === 0 ? '\n✓ All statistics checks passed.\n' : `\n✘ ${failures} check(s) failed.\n`,
);

process.exit(failures === 0 ? 0 : 1);
