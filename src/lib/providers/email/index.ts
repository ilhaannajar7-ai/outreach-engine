import { env } from '@/lib/env';
import type { EmailService } from './types';
import { ResendEmailService } from './resend';
import { SmartleadEmailService } from './smartlead';
import { SmtpEmailService } from './smtp';
import { ConsoleEmailService } from './console';

export * from './types';
export { ResendEmailService, SmartleadEmailService, SmtpEmailService, ConsoleEmailService };

const instances = new Map<string, EmailService>();

/**
 * Resolve an email provider by name, defaulting to EMAIL_PROVIDER.
 *
 * Taking an explicit name matters: during a provider migration some inboxes
 * still send through the old provider while others use the new one, and each
 * `sending_inboxes` row records which. Instances are cached per name.
 */
export function getEmailService(providerName?: string): EmailService {
  const name = providerName ?? env.EMAIL_PROVIDER;

  const existing = instances.get(name);
  if (existing) return existing;

  let service: EmailService;
  switch (name) {
    case 'resend':
      service = new ResendEmailService();
      break;
    case 'smartlead':
      service = new SmartleadEmailService();
      break;
    case 'smtp':
      service = new SmtpEmailService();
      break;
    case 'console':
      service = new ConsoleEmailService();
      break;
    default:
      throw new Error(
        `Unknown email provider "${name}". Valid values: resend, smartlead, smtp, console.`,
      );
  }

  instances.set(name, service);
  return service;
}

/** Test seam. */
export function setEmailService(name: string, service: EmailService): void {
  instances.set(name, service);
}
