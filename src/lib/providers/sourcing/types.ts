/**
 * Lead sourcing contract — the step before enrichment.
 *
 * Enrichment answers "who works at this company"; sourcing answers "which
 * companies should we be talking to at all". Keeping it behind an interface
 * means the hiring-signal source (Apollo today, a jobs API later) can change
 * without touching the pipeline that consumes it.
 */

export interface SourcingCriteria {
  /** Roles the company is hiring for — the signal we sell against. */
  jobTitles: string[];
  /** Country / city names as the provider spells them. */
  locations?: string[];
  /** Provider-specific employee-count buckets, e.g. '11,50'. */
  employeeRanges?: string[];
  industries?: string[];
  /** Max companies to return in one run. */
  limit?: number;
  /** 1-based page, so a daily run can walk deeper instead of re-reading page 1. */
  page?: number;
}

export interface SourcedCompany {
  name: string;
  /** Bare domain, lower-cased. Companies without one are unusable — we skip them. */
  domain: string;
  website?: string;
  industry?: string;
  sizeRange?: string;
  location?: string;
  country?: string;
  linkedinUrl?: string;
  description?: string;

  /** Human-readable reason this company surfaced, e.g. "Hiring: 2× AR Clerk". */
  hiringSignal?: string;
  /** Link to the posting or company jobs page, when the provider gives one. */
  hiringSignalUrl?: string;
  /** Provider's own id, so a later call can ask for more detail. */
  providerCompanyId?: string;
}

export interface LeadSourcingService {
  readonly name: string;

  /** Companies matching the criteria. Never throws for "no results" — returns []. */
  findHiringCompanies(criteria: SourcingCriteria): Promise<SourcedCompany[]>;

  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

export class SourcingRetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SourcingRetryableError';
  }
}

export class SourcingFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcingFatalError';
  }
}

/** Credits are exhausted — stop, notify, do not retry into an empty wallet. */
export class SourcingQuotaError extends SourcingFatalError {
  constructor(message: string) {
    super(message);
    this.name = 'SourcingQuotaError';
  }
}
