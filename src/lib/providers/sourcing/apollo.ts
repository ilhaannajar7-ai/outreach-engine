/**
 * Apollo implementation of LeadSourcingService.
 *
 * Finds companies that are actively hiring for the roles we can staff, which is
 * the buying signal the whole pipeline is built on. Two calls per company at
 * most: one search for the batch, then an optional job-postings lookup to turn
 * "is hiring" into "hiring 2 AR clerks, posted Tuesday" — the difference between
 * a generic email and one worth sending.
 *
 * Apollo's search endpoints need a paid plan with API access enabled; a free
 * key returns 403 here. Field names below follow Apollo's documented shape, and
 * every read is defensive so a renamed field degrades to a missing detail
 * rather than a crashed run. Validate against a live key with:
 *   npx tsx --env-file=.env scripts/test-sourcing.ts
 */

import { env } from '@/lib/env';
import {
  type LeadSourcingService,
  type SourcingCriteria,
  type SourcedCompany,
  SourcingRetryableError,
  SourcingFatalError,
  SourcingQuotaError,
} from './types';

const API_BASE = 'https://api.apollo.io/api/v1';

/** Cap on job-posting detail lookups per run, so one run cannot burn the plan. */
const MAX_DETAIL_LOOKUPS = 25;

export class ApolloSourcingService implements LeadSourcingService {
  readonly name = 'apollo';
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.APOLLO_API_KEY;
    if (!key) throw new SourcingFatalError('APOLLO_API_KEY is required for the Apollo provider');
    this.apiKey = key;
  }

  async findHiringCompanies(criteria: SourcingCriteria): Promise<SourcedCompany[]> {
    const perPage = Math.min(criteria.limit ?? 25, 100);

    const body: Record<string, unknown> = {
      page: criteria.page ?? 1,
      per_page: perPage,
    };

    // The hiring filter is the whole point — without titles this is just a
    // company list, so we refuse rather than silently sourcing noise.
    if (!criteria.jobTitles?.length) {
      throw new SourcingFatalError(
        'Sourcing criteria must include at least one job title to search for.',
      );
    }
    body.q_organization_job_titles = criteria.jobTitles;
    if (criteria.locations?.length) body.organization_locations = criteria.locations;
    if (criteria.employeeRanges?.length) {
      body.organization_num_employees_ranges = criteria.employeeRanges;
    }
    if (criteria.industries?.length) body.q_organization_keyword_tags = criteria.industries;

    const response = await this.request('/mixed_companies/search', body);

    const organizations = [
      ...(asArray(response, 'organizations')),
      ...(asArray(response, 'accounts')),
    ];

    const companies: SourcedCompany[] = [];
    for (const entry of organizations) {
      const org = entry as Record<string, unknown>;
      const domain = normalizeDomain(
        str(org.primary_domain) ?? str(org.domain) ?? str(org.website_url),
      );
      // No domain means we cannot enrich or send — drop it here rather than
      // creating a company row that can never progress.
      if (!domain) continue;

      const employees = num(org.estimated_num_employees);

      companies.push({
        name: str(org.name) ?? domain,
        domain,
        ...(str(org.website_url) ? { website: str(org.website_url)! } : {}),
        ...(str(org.industry) ? { industry: str(org.industry)! } : {}),
        ...(employees ? { sizeRange: employeeBucket(employees) } : {}),
        ...(buildLocation(org) ? { location: buildLocation(org)! } : {}),
        ...(str(org.country) ? { country: str(org.country)! } : {}),
        ...(str(org.linkedin_url) ? { linkedinUrl: str(org.linkedin_url)! } : {}),
        ...(str(org.short_description) ? { description: str(org.short_description)! } : {}),
        ...(str(org.id) ? { providerCompanyId: str(org.id)! } : {}),
      });
    }

    await this.attachHiringSignals(companies, criteria.jobTitles);
    return companies;
  }

  /**
   * Turn "matched the hiring filter" into a specific, quotable signal. Best
   * effort by design: a company keeps its place in the batch even if its
   * postings lookup fails, it just carries a generic signal instead.
   */
  private async attachHiringSignals(
    companies: SourcedCompany[],
    jobTitles: string[],
  ): Promise<void> {
    const targets = companies.slice(0, MAX_DETAIL_LOOKUPS);

    for (const company of targets) {
      if (!company.providerCompanyId) continue;

      try {
        const response = await this.request(
          `/organizations/${company.providerCompanyId}/job_postings`,
          undefined,
          'GET',
        );
        const postings = asArray(response, 'organization_job_postings');

        const matched = postings
          .map((p) => p as Record<string, unknown>)
          .filter((p) => {
            const title = str(p.title)?.toLowerCase() ?? '';
            return jobTitles.some((t) => title.includes(t.toLowerCase()));
          });

        const relevant = matched.length ? matched : postings.map((p) => p as Record<string, unknown>);
        if (!relevant.length) continue;

        const titles = relevant
          .map((p) => str(p.title))
          .filter((t): t is string => Boolean(t))
          .slice(0, 3);
        if (!titles.length) continue;

        company.hiringSignal = `Hiring: ${titles.join(', ')}${
          relevant.length > titles.length ? ` (+${relevant.length - titles.length} more)` : ''
        }`;
        const url = str(relevant[0]!.url);
        if (url) company.hiringSignalUrl = url;
      } catch {
        // Detail is a nice-to-have; the generic fallback below still ships.
      }
    }

    for (const company of companies) {
      if (!company.hiringSignal) {
        company.hiringSignal = `Actively hiring for ${jobTitles.slice(0, 2).join(' / ')}`;
      }
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      await this.request('/mixed_companies/search', { page: 1, per_page: 1 });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async request(
    path: string,
    body?: Record<string, unknown>,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': this.apiKey,
        },
        ...(method === 'POST' && body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new SourcingRetryableError(
        `Apollo request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.ok) return response.json();

    const text = await response.text().catch(() => '');

    if (response.status === 429) {
      throw new SourcingRetryableError('Apollo rate limit reached', 60_000);
    }
    if (response.status === 402 || /credit|quota|limit reached/i.test(text)) {
      throw new SourcingQuotaError(`Apollo credits exhausted: ${text.slice(0, 200)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SourcingFatalError(
        `Apollo rejected the API key (${response.status}). Apollo's search API requires a ` +
          `paid plan with API access enabled. Response: ${text.slice(0, 200)}`,
      );
    }
    if (response.status >= 500) {
      throw new SourcingRetryableError(`Apollo server error ${response.status}`);
    }
    throw new SourcingFatalError(`Apollo error ${response.status}: ${text.slice(0, 200)}`);
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(response: unknown, key: string): unknown[] {
  if (!response || typeof response !== 'object') return [];
  const value = (response as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function buildLocation(org: Record<string, unknown>): string | undefined {
  const parts = [str(org.city), str(org.state), str(org.country)].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

/** Strip protocol, www, path, and port so it matches how companies.domain is stored. */
function normalizeDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!
    .split(':')[0]!;
  return cleaned.includes('.') ? cleaned : undefined;
}

/** Apollo returns a headcount; the schema stores a range string. */
function employeeBucket(count: number): string {
  if (count < 11) return '1-10';
  if (count < 51) return '11-50';
  if (count < 201) return '51-200';
  if (count < 501) return '201-500';
  if (count < 1001) return '501-1000';
  if (count < 5001) return '1001-5000';
  return '5000+';
}
