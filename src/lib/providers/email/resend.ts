/**
 * Resend implementation of EmailService — the Phase 1 provider.
 *
 * Only file that imports the Resend SDK.
 */

import { Resend } from 'resend';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import {
  type EmailService,
  type SendEmailRequest,
  type SendEmailResult,
  type NormalizedEmailEvent,
  type NormalizedInboundEmail,
  type EmailEventKind,
  EmailRetryableError,
  EmailFatalError,
} from './types';

const EVENT_MAP: Record<string, EmailEventKind> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'failed',
};

export class ResendEmailService implements EmailService {
  readonly name = 'resend';
  private client: Resend;

  constructor(apiKey?: string) {
    this.client = new Resend(apiKey ?? env.RESEND_API_KEY);
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    try {
      const headers: Record<string, string> = {};
      if (request.inReplyTo) headers['In-Reply-To'] = request.inReplyTo;
      if (request.references?.length) headers['References'] = request.references.join(' ');

      const { data, error } = await this.client.emails.send({
        from: `${request.fromName} <${request.from}>`,
        to: request.to,
        subject: request.subject,
        text: request.text,
        ...(request.html ? { html: request.html } : {}),
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(request.metadata ? { tags: toTags(request.metadata) } : {}),
      });

      if (error) throw this.normalizeError(error);
      if (!data?.id) throw new EmailFatalError('Resend returned no message id');

      return {
        providerMessageId: data.id,
        acceptedAt: new Date(),
      };
    } catch (error) {
      if (error instanceof EmailRetryableError || error instanceof EmailFatalError) throw error;
      throw this.normalizeError(error);
    }
  }

  parseWebhook(body: unknown): NormalizedEmailEvent[] {
    if (!body || typeof body !== 'object') return [];

    const payload = body as {
      type?: string;
      created_at?: string;
      data?: { email_id?: string; bounce?: { type?: string }; reason?: string };
    };

    const kind = payload.type ? EVENT_MAP[payload.type] : undefined;
    const providerMessageId = payload.data?.email_id;
    if (!kind || !providerMessageId) return [];

    const occurredAt = payload.created_at ? new Date(payload.created_at) : new Date();

    return [
      {
        // Resend does not send a stable event id, so we synthesize one that is
        // unique per (message, event type, second) to keep the dedupe index honest.
        providerEventId: `${providerMessageId}:${kind}:${Math.floor(occurredAt.getTime() / 1000)}`,
        providerMessageId,
        kind,
        occurredAt,
        ...(payload.data?.bounce?.type ? { bounceType: payload.data.bounce.type } : {}),
        ...(payload.data?.reason ? { reason: payload.data.reason } : {}),
        raw: body,
      },
    ];
  }

  parseInboundEmail(body: unknown): NormalizedInboundEmail | null {
    if (!body || typeof body !== 'object') return null;

    // Resend Inbound delivers `email.received` events with the parsed message
    // under `data`. Header names arrive lower-cased in the headers array.
    const payload = body as {
      type?: string;
      created_at?: string;
      data?: {
        email_id?: string;
        from?: string;
        to?: string | string[];
        subject?: string;
        text?: string;
        html?: string;
        headers?: Record<string, string> | { name: string; value: string }[];
      };
    };

    if (payload.type && payload.type !== 'email.received' && payload.type !== 'inbound.email') {
      return null;
    }

    const data = payload.data;
    if (!data?.from) return null;

    const headerMap = normalizeHeaders(data.headers);
    const references = (headerMap['references'] ?? '')
      .split(/\s+/)
      .map((r) => r.trim())
      .filter(Boolean);

    return {
      fromAddress: extractAddress(data.from),
      toAddress: extractAddress(Array.isArray(data.to) ? data.to[0] ?? '' : data.to ?? ''),
      subject: data.subject ?? '(no subject)',
      text: data.text ?? '',
      ...(data.html ? { html: data.html } : {}),
      ...(headerMap['in-reply-to'] ? { inReplyTo: headerMap['in-reply-to'].trim() } : {}),
      references,
      ...(data.email_id ? { providerMessageId: data.email_id } : {}),
      receivedAt: payload.created_at ? new Date(payload.created_at) : new Date(),
      raw: body,
    };
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    const secret = env.RESEND_WEBHOOK_SECRET;
    if (!secret) return false;

    // Svix-format headers, as used by Resend.
    const svixId = headers['svix-id'];
    const svixTimestamp = headers['svix-timestamp'];
    const svixSignature = headers['svix-signature'];
    if (!svixId || !svixTimestamp || !svixSignature) return false;

    // Reject anything older than 5 minutes to blunt replay attempts.
    const timestampSeconds = Number(svixTimestamp);
    if (!Number.isFinite(timestampSeconds)) return false;
    if (Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;

    try {
      const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
      const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
      const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

      // The header may carry several space-separated `v1,<sig>` versions.
      return svixSignature.split(' ').some((part) => {
        const sig = part.split(',')[1];
        if (!sig) return false;
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        return a.length === b.length && timingSafeEqual(a, b);
      });
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      // Listing domains is a read-only call that proves the key works.
      const { error } = await this.client.domains.list();
      if (error) {
        return { ok: false, latencyMs: Date.now() - started, error: error.message };
      }
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private normalizeError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const name = (error as { name?: string })?.name ?? '';

    if (/rate.?limit|too.?many/i.test(message) || name === 'rate_limit_exceeded') {
      return new EmailRetryableError(`Resend rate limit: ${message}`, 60_000);
    }
    if (/invalid.*(email|recipient|address)/i.test(message)) {
      return new EmailFatalError(`Invalid recipient: ${message}`, true);
    }
    if (/unauthor|forbidden|api.?key/i.test(message)) {
      return new EmailFatalError(`Resend authentication failed — check RESEND_API_KEY`);
    }
    if (/timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|5\d\d/i.test(message)) {
      return new EmailRetryableError(`Resend transient error: ${message}`);
    }
    return new EmailFatalError(`Resend error: ${message}`);
  }
}

/** Resend tag values must be ASCII alphanumerics, underscores, or dashes. */
function toTags(metadata: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(metadata).map(([name, value]) => ({
    name: name.replace(/[^a-zA-Z0-9_-]/g, '_'),
    value: value.replace(/[^a-zA-Z0-9_-]/g, '_'),
  }));
}

/** Pull the bare address out of a "Name <addr@x.com>" string, lower-cased. */
function extractAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}

/** Accept headers as either a map or a name/value array; return a lower-keyed map. */
function normalizeHeaders(
  headers: Record<string, string> | { name: string; value: string }[] | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map((h) => [h.name.toLowerCase(), h.value]));
  }
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
