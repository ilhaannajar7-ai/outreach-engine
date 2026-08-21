import { env } from '@/lib/env';
import type { EnrichmentService, FoundContact, EmailVerificationResult } from './types';
import { HunterEnrichmentService } from './hunter';

export * from './types';
export { HunterEnrichmentService };

/**
 * No-op provider. Used when ENRICHMENT_PROVIDER=none — contacts are imported by
 * CSV and verification is skipped. `isSafeToSend` stays false so a lead is never
 * silently sent to on the strength of an unverified address.
 */
export class NoopEnrichmentService implements EnrichmentService {
  readonly name = 'none';

  async findContacts(): Promise<FoundContact[]> {
    return [];
  }

  async verifyEmail(email: string): Promise<EmailVerificationResult> {
    return {
      email,
      status: 'unknown',
      score: 0,
      isDisposable: false,
      isRoleAccount: false,
      isSafeToSend: false,
    };
  }

  async getRemainingCredits(): Promise<number | null> {
    return null;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }
}

let instance: EnrichmentService | null = null;

export function getEnrichmentService(): EnrichmentService {
  if (instance) return instance;

  switch (env.ENRICHMENT_PROVIDER) {
    case 'hunter':
      instance = new HunterEnrichmentService();
      break;
    case 'apollo':
      // Apollo lands here when the seat is purchased; the interface is already
      // the one the app consumes, so nothing above this line changes.
      throw new Error('Apollo enrichment provider is not implemented yet. Use hunter or none.');
    case 'none':
    default:
      instance = new NoopEnrichmentService();
      break;
  }

  return instance;
}

export function setEnrichmentService(service: EnrichmentService): void {
  instance = service;
}
