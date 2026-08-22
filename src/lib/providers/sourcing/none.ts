/**
 * No-op sourcing provider — the default.
 *
 * Auto-sourcing spends money on every run, so it stays off until a provider is
 * deliberately configured. CSV import still works; this only disables the
 * scheduled "go find companies" job.
 */

import type { LeadSourcingService, SourcedCompany } from './types';

export class NoopSourcingService implements LeadSourcingService {
  readonly name = 'none';

  async findHiringCompanies(): Promise<SourcedCompany[]> {
    return [];
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }
}
