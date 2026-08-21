/**
 * Hook quality scoring.
 *
 * The research prompt asks for specific, verifiable hooks. Asking is not
 * enough — a model under-supplied with facts will still produce "they are
 * growing and looking to scale", which reads as obviously automated and is the
 * single biggest driver of a 1% reply rate instead of a 5% one.
 *
 * This module is the enforcement layer. It scores each hook on whether it says
 * something that could ONLY be true of this company, and the research job
 * refuses to hand a brief to email generation when nothing clears the bar.
 *
 * The test being applied throughout: could this sentence appear, unchanged, in
 * an email to a different company? If yes, it is not a hook.
 */

/** A hook scoring at or above this is specific enough to build an email on. */
export const HOOK_QUALITY_THRESHOLD = 60;

/**
 * Phrases that appear in generic outreach and say nothing checkable.
 *
 * Weighted by how strongly each one signals filler. "Companies like yours" is
 * fatal — it literally announces that the sentence is not about them.
 */
const GENERIC_MARKERS: { pattern: RegExp; penalty: number; label: string }[] = [
  { pattern: /\bcompanies like (yours|theirs)\b/i, penalty: 45, label: '"companies like yours"' },
  { pattern: /\bbusinesses (like|such as) (yours|theirs)\b/i, penalty: 45, label: 'generic peer comparison' },
  { pattern: /\bin (today's|this) (competitive|fast-paced|changing)\b/i, penalty: 40, label: 'stock scene-setting' },
  { pattern: /\bmany (companies|businesses|firms|organisations|organizations)\b/i, penalty: 35, label: '"many companies"' },
  { pattern: /\b(is|are|appears to be) (growing|expanding|scaling)\b/i, penalty: 30, label: 'vague growth claim' },
  { pattern: /\blooking to (improve|optimi[sz]e|streamline|enhance|grow|scale)\b/i, penalty: 30, label: 'vague intent claim' },
  { pattern: /\b(leading|innovative|dynamic|forward-thinking|world-class|cutting-edge)\b/i, penalty: 30, label: 'marketing adjective' },
  { pattern: /\bcommitted to (excellence|quality|growth|innovation)\b/i, penalty: 35, label: 'boilerplate values claim' },
  { pattern: /\b(leverage|synergy|synergies|best-in-class|game-chang)/i, penalty: 30, label: 'corporate filler' },
  { pattern: /\byour industry\b/i, penalty: 25, label: '"your industry"' },
  { pattern: /\bi (came across|stumbled upon|noticed)\b(?!.*\d)/i, penalty: 25, label: 'discovery opener with no specifics' },
  { pattern: /\bhope (this|you) (finds you well|are well|is well)\b/i, penalty: 45, label: 'stock greeting' },
  { pattern: /\b(exciting|great|perfect) (opportunity|fit|match)\b/i, penalty: 30, label: 'unearned enthusiasm' },
  { pattern: /\bhelp (businesses|companies|you) (scale|grow|succeed)\b/i, penalty: 30, label: 'vague benefit claim' },
  { pattern: /\bfocus(ed|ing)? on (growth|efficiency|success)\b/i, penalty: 25, label: 'vague focus claim' },
];

/**
 * Role words. A hook naming an actual role is anchored to something the
 * recipient can verify — they posted that job.
 */
const ROLE_WORDS =
  /\b(clerks?|analysts?|managers?|directors?|coordinators?|assistants?|specialists?|officers?|controllers?|bookkeepers?|accountants?|administrators?|executives?|agents?|representatives?|supervisors?|receptionists?|payroll|bookkeeping|cfo|coo|ceo|md|vp|head of|accounts? (payable|receivable)|ap|ar)\b/i;

/** Time anchors — "twice since March" is checkable; "recently" alone is not. */
const TIME_MARKERS =
  /\b(since|last (month|week|quarter|year)|this (month|quarter|year)|q[1-4]\b|january|february|march|april|may|june|july|august|september|october|november|december|twice|second time|third|again|\d+\s*(days?|weeks?|months?)\s*ago)\b/i;

/** Counting language — "three AR clerks" is the strongest hook shape there is. */
const QUANTITY_MARKERS =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|dozen|several|multiple)\b/i;

export interface HookAssessment {
  score: number;
  isSpecific: boolean;
  /** Human-readable notes explaining the score, shown in the dashboard. */
  notes: string[];
}

/**
 * Score one hook.
 *
 * Starts neutral and moves on evidence: concrete anchors (numbers, roles,
 * dates) raise it, recognisable filler drops it hard. The inference is scored
 * more leniently than the observation — an inference is *supposed* to be an
 * interpretive leap, while the observation must be a verifiable fact.
 */
export function assessHook(hook: { observation: string; inference?: string }): HookAssessment {
  const observation = hook.observation?.trim() ?? '';
  const inference = hook.inference?.trim() ?? '';
  const notes: string[] = [];

  if (observation.length < 15) {
    return { score: 0, isSpecific: false, notes: ['Observation is too short to be a real fact.'] };
  }

  let score = 45;

  // --- Anchors: things that make a claim checkable -------------------------
  if (QUANTITY_MARKERS.test(observation)) {
    score += 22;
    notes.push('Includes a quantity.');
  }
  if (ROLE_WORDS.test(observation)) {
    score += 18;
    notes.push('Names a specific role.');
  }
  if (TIME_MARKERS.test(observation)) {
    score += 14;
    notes.push('Anchored in time.');
  }

  // An inference that goes beyond restating the observation is what makes the
  // email read as human — someone thought about what the fact means.
  if (inference.length > 25 && !inference.toLowerCase().includes(observation.toLowerCase().slice(0, 25))) {
    score += 10;
    notes.push('Draws a conclusion rather than restating the fact.');
  }

  // --- Penalties: recognisable filler --------------------------------------
  // Weighted by where the filler appears. The observation must be a verifiable
  // fact, so filler there is disqualifying. The inference is interpretive by
  // design — "billing operations are scaling faster than the admin function"
  // uses the word "scaling" while still saying something specific — so the
  // same phrase costs less there.
  const INFERENCE_PENALTY_WEIGHT = 0.4;

  for (const marker of GENERIC_MARKERS) {
    const inObservation = marker.pattern.test(observation);
    const inInference = !inObservation && marker.pattern.test(inference);
    if (!inObservation && !inInference) continue;

    const penalty = inObservation
      ? marker.penalty
      : Math.round(marker.penalty * INFERENCE_PENALTY_WEIGHT);

    score -= penalty;
    notes.push(
      `Generic phrasing${inInference ? ' in the inference' : ''}: ${marker.label}.`,
    );
  }

  // A hook with no anchor of any kind cannot be company-specific, whatever
  // else it does. Cap it below the threshold rather than letting length or
  // confident phrasing carry it over the line.
  const hasAnyAnchor =
    QUANTITY_MARKERS.test(observation) || ROLE_WORDS.test(observation) || TIME_MARKERS.test(observation);
  if (!hasAnyAnchor) {
    score = Math.min(score, 45);
    notes.push('No number, role, or date — nothing the recipient could verify.');
  }

  score = Math.max(0, Math.min(100, score));

  return { score, isSpecific: score >= HOOK_QUALITY_THRESHOLD, notes };
}

/**
 * Coerce stored hooks into the scored shape.
 *
 * Research written before hooks became observation/inference pairs is a plain
 * `string[]`, and a dashboard-edited prompt can produce that shape again. Both
 * are read back through here so callers never branch on storage format.
 */
export function normalizeHooks(raw: unknown): { observation: string; inference: string; score: number }[] {
  // A jsonb column can come back as a JSON string rather than a parsed array —
  // double-encoded on write, or a driver that does not auto-parse. Returning []
  // here would silently block every lead, so unwrap one level before giving up.
  if (typeof raw === 'string') {
    try {
      return normalizeHooks(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      if (typeof entry === 'string') {
        return { observation: entry, inference: '', score: assessHook({ observation: entry }).score };
      }
      if (entry && typeof entry === 'object' && 'observation' in entry) {
        const hook = entry as { observation?: unknown; inference?: unknown; score?: unknown };
        const observation = String(hook.observation ?? '');
        const inference = String(hook.inference ?? '');
        return {
          observation,
          inference,
          // Re-score rather than trusting a stored value, so a threshold change
          // applies to existing research without a backfill.
          score: typeof hook.score === 'number' ? hook.score : assessHook({ observation, inference }).score,
        };
      }
      return null;
    })
    .filter((hook): hook is { observation: string; inference: string; score: number } =>
      Boolean(hook && hook.observation),
    )
    .sort((a, b) => b.score - a.score);
}

export interface ResearchQuality {
  /** Highest single hook score in the brief. */
  bestScore: number;
  /** Hooks that cleared the threshold, best first. */
  usableHooks: { observation: string; inference: string; score: number }[];
  /** True when at least one hook is specific enough to write an email from. */
  isUsable: boolean;
  /** Shown to the operator when research is rejected. */
  summary: string;
}

/**
 * Assess a whole research brief.
 *
 * Deliberately strict: one strong hook beats four weak ones, because the email
 * only ever builds on the best one. If nothing clears the bar, the honest
 * outcome is to tell the operator the inputs were too thin — not to generate a
 * plausible-sounding email built on nothing.
 */
export function assessResearch(
  hooks: { observation: string; inference?: string }[],
): ResearchQuality {
  const scored = hooks
    .map((hook) => ({
      observation: hook.observation,
      inference: hook.inference ?? '',
      ...assessHook(hook),
    }))
    .sort((a, b) => b.score - a.score);

  const usable = scored.filter((h) => h.isSpecific);
  const bestScore = scored[0]?.score ?? 0;

  let summary: string;
  if (usable.length > 0) {
    summary = `${usable.length} of ${scored.length} hook${scored.length === 1 ? '' : 's'} are specific enough to build on.`;
  } else if (scored.length === 0) {
    summary = 'Research produced no hooks at all. The company record is likely too thin.';
  } else {
    summary =
      `None of the ${scored.length} hooks are company-specific — the best scored ${bestScore}/100. ` +
      'Add a real hiring signal or company description and re-run research, ' +
      'or skip this lead. An email built on this would read as automated.';
  }

  return {
    bestScore,
    usableHooks: usable.map(({ observation, inference, score }) => ({ observation, inference, score })),
    isUsable: usable.length > 0,
    summary,
  };
}
