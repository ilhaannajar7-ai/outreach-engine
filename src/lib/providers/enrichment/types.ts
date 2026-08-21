/**
 * Contact enrichment / email verification contract.
 *
 * Hunter in V1, Apollo when lead volume justifies the seat. Verification is the
 * part that actually protects deliverability — an unverified address that hard
 * bounces damages the sending domain far more than a missed lead costs.
 */

export type VerificationStatus =
  | 'valid'
  | 'invalid'
  | 'accept_all'
  | 'disposable'
  | 'role_account'
  | 'unknown';

export interface EmailVerificationResult {
  email: string;
  status: VerificationStatus;
  /** 0–100 provider confidence. */
  score: number;
  isDisposable: boolean;
  isRoleAccount: boolean;
  /** Our verdict. False means: do not send, whatever the provider called it. */
  isSafeToSend: boolean;
  raw?: unknown;
}

export interface FoundContact {
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  jobTitle?: string;
  seniority?: string;
  department?: string;
  linkedinUrl?: string;
  confidence: number;
}

export interface FindContactsRequest {
  companyDomain: string;
  companyName?: string;
  /** e.g. ['CFO', 'Head of Finance'] — provider filters when it supports it. */
  jobTitles?: string[];
  seniorities?: string[];
  departments?: string[];
  limit?: number;
}

export interface EnrichmentService {
  readonly name: string;

  findContacts(request: FindContactsRequest): Promise<FoundContact[]>;
  verifyEmail(email: string): Promise<EmailVerificationResult>;

  /** Remaining provider credits, when the provider exposes it. */
  getRemainingCredits(): Promise<number | null>;

  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

export class EnrichmentRetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'EnrichmentRetryableError';
  }
}

export class EnrichmentFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentFatalError';
  }
}

/** Out of credits — a Tier-3 stop, not a retry. */
export class EnrichmentQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentQuotaError';
  }
}
