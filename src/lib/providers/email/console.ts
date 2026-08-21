/**
 * Console implementation of EmailService — development only.
 *
 * Logs what would have been sent instead of sending it. This is the default
 * provider so a fresh checkout can never accidentally email a real prospect
 * before credentials are deliberately configured.
 */

import { randomUUID } from 'node:crypto';
import type {
  EmailService,
  SendEmailRequest,
  SendEmailResult,
  NormalizedEmailEvent,
  NormalizedInboundEmail,
} from './types';

export class ConsoleEmailService implements EmailService {
  readonly name = 'console';

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    const id = randomUUID();
    console.log(
      [
        '',
        '─────────── EMAIL (console provider — not sent) ───────────',
        `  from:    ${request.fromName} <${request.from}>`,
        `  to:      ${request.to}`,
        `  subject: ${request.subject}`,
        request.inReplyTo ? `  replyTo: ${request.inReplyTo}` : null,
        '  ---',
        request.text
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
        `─────────── id: ${id} ───────────`,
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return { providerMessageId: id, acceptedAt: new Date() };
  }

  parseWebhook(): NormalizedEmailEvent[] {
    return [];
  }

  /**
   * The console provider never receives real mail, but it accepts a simple
   * hand-rolled payload so the inbound reply path can be exercised locally
   * without a real provider or a public URL:
   *   { from, to, subject, text, inReplyTo?, references? }
   */
  parseInboundEmail(body: unknown): NormalizedInboundEmail | null {
    if (!body || typeof body !== 'object') return null;
    const p = body as {
      from?: string;
      to?: string;
      subject?: string;
      text?: string;
      inReplyTo?: string;
      references?: string[];
    };
    if (!p.from || !p.text) return null;

    return {
      fromAddress: p.from.trim().toLowerCase(),
      toAddress: (p.to ?? '').trim().toLowerCase(),
      subject: p.subject ?? '(no subject)',
      text: p.text,
      ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}),
      references: p.references ?? [],
      receivedAt: new Date(),
      raw: body,
    };
  }

  verifyWebhookSignature(): boolean {
    // The console provider only runs in dev; the inbound route allows it through
    // explicitly (see the route), so signature verification is not applicable.
    return false;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }
}
