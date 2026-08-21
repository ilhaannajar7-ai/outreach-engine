/**
 * Who to contact at a company, and how to rank the candidates Hunter returns.
 *
 * "Relevant" for an outsourcing offer means a decision-maker in the function
 * whose work you'd take on — finance, operations, or general management — with
 * enough seniority to say yes to a service. HR and junior staff are not that
 * person, however deliverable their address is, so they are actively down-ranked
 * rather than merely not preferred.
 */

import type { FoundContact } from '@/lib/providers/enrichment';

/**
 * Default search filters for an outsourcing offer.
 *
 * Passed to Hunter to narrow the domain search. A campaign's own targetRole
 * overrides the titles when set.
 */
export const DEFAULT_TARGET = {
  seniorities: ['executive', 'senior'],
  departments: ['finance', 'operations', 'management', 'executive'],
  jobTitles: [
    'CFO',
    'Chief Financial Officer',
    'Finance Director',
    'Head of Finance',
    'Finance Manager',
    'Financial Controller',
    'COO',
    'Operations Director',
    'Head of Operations',
    'Operations Manager',
    'Managing Director',
    'General Manager',
    'Owner',
    'Founder',
  ],
};

// Ranked high → low. A CFO beats an ops manager beats an office admin.
const TITLE_SCORE: { pattern: RegExp; score: number }[] = [
  { pattern: /\b(cfo|chief financial)\b/i, score: 100 },
  { pattern: /\bfinance director\b/i, score: 95 },
  { pattern: /\bfinancial controller\b/i, score: 90 },
  { pattern: /\bhead of finance\b/i, score: 90 },
  { pattern: /\b(coo|chief operating)\b/i, score: 88 },
  { pattern: /\bfinance manager\b/i, score: 82 },
  { pattern: /\b(managing director|\bmd\b)\b/i, score: 80 },
  { pattern: /\boperations director\b/i, score: 78 },
  { pattern: /\bhead of operations\b/i, score: 75 },
  { pattern: /\b(owner|founder|proprietor)\b/i, score: 74 },
  { pattern: /\bgeneral manager\b/i, score: 70 },
  { pattern: /\boperations manager\b/i, score: 66 },
  { pattern: /\b(finance|accounts|accounting)\b/i, score: 55 },
  { pattern: /\b(director|vp|vice president|head of)\b/i, score: 50 },
  { pattern: /\bmanager\b/i, score: 40 },
];

// Wrong person for this offer — penalised hard so they never win a tie, and
// usually fall below the acceptance bar entirely.
const WRONG_FUNCTION = /\b(hr|human resources|recruit|talent|marketing|sales|it |developer|engineer|designer|support|intern)\b/i;

const SENIORITY_BONUS: Record<string, number> = {
  executive: 20,
  senior: 10,
  junior: -15,
};

export interface RankedContact extends FoundContact {
  /** 0-120ish; higher is a better person to approach. */
  targetScore: number;
  /** Why it scored this way, for the audit trail. */
  reason: string;
}

/** Score one candidate on how good a target they are. */
export function scoreContact(contact: FoundContact): RankedContact {
  const title = contact.jobTitle ?? '';
  const reasons: string[] = [];

  let score = 0;

  const titleMatch = TITLE_SCORE.find((t) => t.pattern.test(title));
  if (titleMatch) {
    score += titleMatch.score;
    reasons.push(`title "${title}"`);
  } else if (title) {
    score += 20;
    reasons.push(`unrecognised title "${title}"`);
  } else {
    reasons.push('no title');
  }

  if (contact.seniority && SENIORITY_BONUS[contact.seniority] !== undefined) {
    score += SENIORITY_BONUS[contact.seniority]!;
    reasons.push(`${contact.seniority} seniority`);
  }

  if (WRONG_FUNCTION.test(title)) {
    score -= 60;
    reasons.push('wrong function for this offer');
  }

  // Hunter's own confidence in the address as a light tiebreaker.
  score += Math.round((contact.confidence ?? 0) / 10);

  return { ...contact, targetScore: Math.max(0, score), reason: reasons.join(', ') };
}

/**
 * Rank candidates and keep the ones worth pursuing.
 *
 * Anything below the floor is a poor fit (wrong function, or too junior) and is
 * dropped rather than emailed — a verified address for the wrong person still
 * produces zero replies and drags the whole list's engagement down.
 */
export function rankContacts(
  contacts: FoundContact[],
  minScore = 45,
): { best: RankedContact | null; ranked: RankedContact[]; rejected: RankedContact[] } {
  const scored = contacts.map(scoreContact).sort((a, b) => b.targetScore - a.targetScore);
  const ranked = scored.filter((c) => c.targetScore >= minScore);
  const rejected = scored.filter((c) => c.targetScore < minScore);

  return { best: ranked[0] ?? null, ranked, rejected };
}

/** Merge campaign-specific role targeting over the defaults. */
export function targetFilters(campaignRole?: string | null) {
  if (!campaignRole?.trim()) return DEFAULT_TARGET;

  // A campaign role string like "CFO, Finance Manager" becomes the title
  // filter; seniority/department defaults still apply.
  const titles = campaignRole
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    ...DEFAULT_TARGET,
    jobTitles: titles.length > 0 ? titles : DEFAULT_TARGET.jobTitles,
  };
}
