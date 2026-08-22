import { env } from '@/lib/env';
import type { LeadSourcingService } from './types';
import { ApolloSourcingService } from './apollo';
import { NoopSourcingService } from './none';

export * from './types';
export { ApolloSourcingService, NoopSourcingService };

const instances = new Map<string, LeadSourcingService>();

/** Resolve a sourcing provider by name, defaulting to SOURCING_PROVIDER. */
export function getSourcingService(providerName?: string): LeadSourcingService {
  const name = providerName ?? env.SOURCING_PROVIDER;

  const existing = instances.get(name);
  if (existing) return existing;

  let service: LeadSourcingService;
  switch (name) {
    case 'apollo':
      service = new ApolloSourcingService();
      break;
    case 'none':
      service = new NoopSourcingService();
      break;
    default:
      throw new Error(`Unknown sourcing provider "${name}". Valid values: apollo, none.`);
  }

  instances.set(name, service);
  return service;
}

/** Test seam. */
export function setSourcingService(name: string, service: LeadSourcingService): void {
  instances.set(name, service);
}
