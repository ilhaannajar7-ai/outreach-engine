/**
 * Significance testing for strategy variants.
 *
 * This module exists to stop the dashboard declaring a winner from noise. With
 * cold email, reply rates sit around 2-5%, so a variant that is "ahead" after
 * forty sends is almost always ahead by luck. Calling that a win and rolling it
 * out to every lead is worse than having no test at all — it replaces a working
 * approach with a random one and hides the mistake behind a number.
 *
 * Two-proportion z-test against the control, with a Bonferroni correction
 * because testing several variants at once inflates false positives.
 */

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (max error ~1.5e-7). */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;

  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

export interface ProportionSample {
  /** Number of successes, e.g. replies. */
  successes: number;
  /** Number of trials, e.g. emails sent. */
  trials: number;
}

export interface ComparisonResult {
  controlRate: number;
  variantRate: number;
  /** Relative change vs control, e.g. 0.4 = 40% better. */
  lift: number;
  zScore: number;
  pValue: number;
  /** True only if p is below the corrected threshold. */
  isSignificant: boolean;
  /** The threshold actually applied, after correction. */
  alpha: number;
}

/**
 * Two-proportion z-test.
 *
 * `alpha` should already carry any multiple-comparison correction — this
 * function does not know how many other tests are being run alongside it.
 */
export function compareProportions(
  control: ProportionSample,
  variant: ProportionSample,
  alpha = 0.05,
): ComparisonResult {
  const n1 = control.trials;
  const n2 = variant.trials;

  const p1 = n1 > 0 ? control.successes / n1 : 0;
  const p2 = n2 > 0 ? variant.successes / n2 : 0;
  const lift = p1 > 0 ? (p2 - p1) / p1 : 0;

  // With no data on either side there is nothing to test. Returning p=1 keeps
  // callers from having to special-case it — it simply never reads as a win.
  if (n1 === 0 || n2 === 0) {
    return { controlRate: p1, variantRate: p2, lift, zScore: 0, pValue: 1, isSignificant: false, alpha };
  }

  const pooled = (control.successes + variant.successes) / (n1 + n2);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));

  // Happens when both arms are all-successes or all-failures; the difference
  // carries no information either way.
  if (standardError === 0) {
    return { controlRate: p1, variantRate: p2, lift, zScore: 0, pValue: 1, isSignificant: false, alpha };
  }

  const zScore = (p2 - p1) / standardError;
  const pValue = 2 * (1 - normalCdf(Math.abs(zScore)));

  return {
    controlRate: p1,
    variantRate: p2,
    lift,
    zScore,
    pValue,
    isSignificant: pValue < alpha,
    alpha,
  };
}

/**
 * Sends per variant needed to detect a given relative lift.
 *
 * Standard two-proportion sample size at 95% confidence and 80% power. The
 * numbers this returns are usually larger than people expect, which is the
 * point: at a 3% reply rate, detecting a 25% improvement genuinely takes
 * thousands of sends per arm. Better to show that up front than to let someone
 * conclude anything from 50.
 */
export function requiredSampleSize(baselineRate: number, minimumDetectableLift: number): number {
  if (baselineRate <= 0 || baselineRate >= 1 || minimumDetectableLift <= 0) return Infinity;

  const p1 = baselineRate;
  const p2 = Math.min(0.999, baselineRate * (1 + minimumDetectableLift));
  const delta = p2 - p1;
  if (delta <= 0) return Infinity;

  const zAlpha = 1.959964; // two-sided 95%
  const zBeta = 0.841621; // 80% power

  const n =
    ((zAlpha + zBeta) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (delta * delta);

  return Math.ceil(n);
}

export interface VariantStats {
  id: string;
  name: string;
  isControl: boolean;
  sent: number;
  replied: number;
  interested: number;
}

export type VariantVerdict =
  | 'control'
  | 'winning'
  | 'losing'
  | 'no_difference'
  | 'insufficient_data';

export interface VariantResult extends VariantStats {
  replyRate: number;
  interestedRate: number;
  comparison: ComparisonResult | null;
  verdict: VariantVerdict;
  /** Plain-language reading of the verdict, shown in the dashboard. */
  explanation: string;
}

export interface ExperimentReadout {
  variants: VariantResult[];
  control: VariantResult | null;
  /** Set only when one variant is significantly better than control. */
  winner: VariantResult | null;
  totalSent: number;
  /** Corrected threshold, after Bonferroni across the non-control arms. */
  alpha: number;
  /** Roughly how many sends per arm this test still needs. */
  recommendedSampleSize: number;
  summary: string;
}

/**
 * The minimum sends per arm before any verdict other than "insufficient data".
 *
 * Even a real effect cannot be distinguished from noise below this, and showing
 * a verdict anyway invites acting on it.
 */
const MIN_SENDS_PER_ARM = 100;

/** Read a whole experiment: every variant against the control. */
export function evaluateExperiment(variants: VariantStats[]): ExperimentReadout {
  const totalSent = variants.reduce((sum, v) => sum + v.sent, 0);
  const control = variants.find((v) => v.isControl) ?? variants[0] ?? null;

  // Bonferroni: each additional arm is another chance to see a fluke, so the
  // bar for each individual comparison has to rise.
  const comparisons = Math.max(1, variants.filter((v) => v.id !== control?.id).length);
  const alpha = 0.05 / comparisons;

  const results: VariantResult[] = variants.map((variant) => {
    const replyRate = variant.sent > 0 ? variant.replied / variant.sent : 0;
    const interestedRate = variant.sent > 0 ? variant.interested / variant.sent : 0;

    if (!control || variant.id === control.id) {
      return {
        ...variant,
        replyRate,
        interestedRate,
        comparison: null,
        verdict: 'control',
        explanation: 'Baseline every other variant is measured against.',
      };
    }

    const comparison = compareProportions(
      { successes: control.replied, trials: control.sent },
      { successes: variant.replied, trials: variant.sent },
      alpha,
    );

    const underpowered = variant.sent < MIN_SENDS_PER_ARM || control.sent < MIN_SENDS_PER_ARM;

    let verdict: VariantVerdict;
    let explanation: string;

    if (underpowered) {
      const short = Math.max(0, MIN_SENDS_PER_ARM - variant.sent);
      verdict = 'insufficient_data';
      explanation =
        short > 0
          ? `Needs about ${short} more sends before this means anything.`
          : `The control arm needs more sends before this comparison means anything.`;
    } else if (comparison.isSignificant) {
      const better = comparison.variantRate > comparison.controlRate;
      verdict = better ? 'winning' : 'losing';
      explanation = better
        ? `Genuinely better: ${(comparison.lift * 100).toFixed(0)}% more replies than control (p=${comparison.pValue.toFixed(3)}).`
        : `Genuinely worse: ${(Math.abs(comparison.lift) * 100).toFixed(0)}% fewer replies than control (p=${comparison.pValue.toFixed(3)}).`;
    } else {
      verdict = 'no_difference';
      explanation =
        `Ahead or behind by chance, not by enough to trust (p=${comparison.pValue.toFixed(2)}). ` +
        'Keep running it.';
    }

    return { ...variant, replyRate, interestedRate, comparison, verdict, explanation };
  });

  const controlResult = results.find((r) => r.verdict === 'control') ?? null;

  // The best significant winner, if there is one at all.
  const winner =
    results
      .filter((r) => r.verdict === 'winning')
      .sort((a, b) => b.replyRate - a.replyRate)[0] ?? null;

  const baseline = controlResult?.replyRate || 0.03;
  const recommendedSampleSize = requiredSampleSize(baseline, 0.3);

  let summary: string;
  if (variants.length < 2) {
    summary = 'Add a second variant to start testing.';
  } else if (winner) {
    summary =
      `"${winner.name}" is winning with a ${(winner.replyRate * 100).toFixed(1)}% reply rate ` +
      `vs ${((controlResult?.replyRate ?? 0) * 100).toFixed(1)}% for control. Safe to promote.`;
  } else if (results.some((r) => r.verdict === 'insufficient_data')) {
    summary =
      `Too early to call. Each variant needs at least ${MIN_SENDS_PER_ARM} sends before the ` +
      'numbers separate signal from noise.';
  } else {
    summary =
      'No variant is meaningfully better than control yet. Either keep running, or try a ' +
      'bigger change — small wording tweaks rarely move reply rate.';
  }

  return {
    variants: results,
    control: controlResult,
    winner,
    totalSent,
    alpha,
    recommendedSampleSize,
    summary,
  };
}
