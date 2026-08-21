/**
 * Hunter.io implementation of EnrichmentService.
 */

import { env } from '@/lib/env';
import {
  type EnrichmentService,
  type FindContactsRequest,
  type FoundContact,
  type EmailVerificationResult,
  type VerificationStatus,
  EnrichmentRetryableError,
  EnrichmentFatalError,
  EnrichmentQuotaError,
} from './types';

const API_BASE = 'https://api.hunter.io/v2';

const STATUS_MAP: Record<string, VerificationStatus> = {
  valid: 'valid',
  invalid: 'invalid',
  accept_all: 'accept_all',
  disposable: 'disposable',
  webmail: 'valid',
  unknown: 'unknown',
};

export class HunterEnrichmentService implements EnrichmentService {
  readonly name = 'hunter';
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.HUNTER_API_KEY;
    if (!key) throw new Error('HUNTER_API_KEY is required for the Hunter provider');
    this.apiKey = key;
  }

  async findContacts(request: FindContactsRequest): Promise<FoundContact[]> {
    const params = new URLSearchParams({
      domain: request.companyDomain,
      api_key: this.apiKey,
      limit: String(request.limit ?? 10),
    });
    if (request.departments?.length) params.set('department', request.departments.join(','));
    if (request.seniorities?.length) params.set('seniority', request.seniorities.join(','));

    const response = await this.request(`/domain-search?${params}`);
    const data = (response as { data?: { emails?: unknown[] } }).data;
    if (!data?.emails) return [];

    const contacts = data.emails.map((entry) => {
      const e = entry as {
        value?: string;
        first_name?: string;
        last_name?: string;
        position?: string;
        seniority?: string;
        department?: string;
        linkedin?: string;
        confidence?: number;
      };
      const fullName = [e.first_name, e.last_name].filter(Boolean).join(' ');
      return {
        email: e.value ?? '',
        ...(e.first_name ? { firstName: e.first_name } : {}),
        ...(e.last_name ? { lastName: e.last_name } : {}),
        ...(fullName ? { fullName } : {}),
        ...(e.position ? { jobTitle: e.position } : {}),
        ...(e.seniority ? { seniority: e.seniority } : {}),
        ...(e.department ? { department: e.department } : {}),
        ...(e.linkedin ? { linkedinUrl: e.linkedin } : {}),
        confidence: e.confidence ?? 0,
      } satisfies FoundContact;
    });

    const withEmail = contacts.filter((c) => c.email.length > 0);

    // Hunter's own title filter is coarse, so narrow client-side when asked.
    if (request.jobTitles?.length) {
      const needles = request.jobTitles.map((t) => t.toLowerCase());
      const matched = withEmail.filter((c) =>
        needles.some((needle) => c.jobTitle?.toLowerCase().includes(needle)),
      );
      if (matched.length > 0) return matched;
    }

    return withEmail;
  }

  async verifyEmail(email: string): Promise<EmailVerificationResult> {
    const params = new URLSearchParams({ email, api_key: this.apiKey });
    const response = await this.request(`/email-verifier?${params}`);

    const data = (response as {
      data?: {
        status?: string;
        score?: number;
        disposable?: boolean;
        webmail?: boolean;
        result?: string;
      };
    }).data;

    const status = STATUS_MAP[data?.status ?? 'unknown'] ?? 'unknown';
    const score = data?.score ?? 0;
    const isDisposable = data?.disposable ?? false;
    const isRoleAccount = /^(info|sales|support|admin|contact|hello|team|office|help|billing|noreply|no-reply)@/i.test(
      email,
    );

    // Deliberately stricter than Hunter's own verdict. accept_all domains
    // silently swallow bad addresses and surface later as hard bounces, so we
    // only send when the score is genuinely high.
    const isSafeToSend =
      !isDisposable &&
      !isRoleAccount &&
      (status === 'valid' || (status === 'accept_all' && score >= 70));

    return { email, status, score, isDisposable, isRoleAccount, isSafeToSend, raw: data };
  }

  async getRemainingCredits(): Promise<number | null> {
    try {
      const response = await this.request(`/account?api_key=${encodeURIComponent(this.apiKey)}`);
      const data = (response as {
        data?: { requests?: { searches?: { available?: number; used?: number } } };
      }).data;
      const searches = data?.requests?.searches;
      if (!searches || searches.available === undefined) return null;
      return searches.available - (searches.used ?? 0);
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      await this.request(`/account?api_key=${encodeURIComponent(this.apiKey)}`);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new EnrichmentRetryableError(
        `Hunter network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new EnrichmentRetryableError(
        'Hunter rate limit',
        retryAfter ? Number(retryAfter) * 1000 : 60_000,
      );
    }
    if (response.status === 402) {
      throw new EnrichmentQuotaError('Hunter credits exhausted — top up or wait for reset');
    }
    if (response.status === 401 || response.status === 403) {
      throw new EnrichmentFatalError('Hunter authentication failed — check HUNTER_API_KEY');
    }
    if (response.status >= 500) {
      throw new EnrichmentRetryableError(`Hunter server error (${response.status})`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new EnrichmentFatalError(`Hunter error (${response.status}): ${text.slice(0, 300)}`);
    }

    return response.json();
  }
}
