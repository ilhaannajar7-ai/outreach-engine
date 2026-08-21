/**
 * Smartlead implementation of EmailService — the Phase 2/3 provider.
 *
 * Smartlead owns inbox rotation and warm-up, so `providerInboxId` selects which
 * connected mailbox sends. Our own inbox rotation stays in place regardless;
 * when Smartlead is active it simply picks the row whose providerInboxId we pass.
 *
 * Switching to this provider is EMAIL_PROVIDER=smartlead plus a key. No other
 * file in the app changes.
 */

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

const API_BASE = 'https://server.smartlead.ai/api/v1';

const EVENT_MAP: Record<string, EmailEventKind> = {
  EMAIL_SENT: 'sent',
  EMAIL_DELIVERED: 'delivered',
  EMAIL_OPEN: 'opened',
  EMAIL_LINK_CLICK: 'clicked',
  EMAIL_BOUNCE: 'bounced',
  EMAIL_SPAM_COMPLAINT: 'complained',
  EMAIL_UNSUBSCRIBE: 'unsubscribed',
  EMAIL_FAILED: 'failed',
};

export class SmartleadEmailService implements EmailService {
  readonly name = 'smartlead';
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.SMARTLEAD_API_KEY;
    if (!key) throw new Error('SMARTLEAD_API_KEY is required for the Smartlead provider');
    this.apiKey = key;
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    const body = {
      email_account_id: request.providerInboxId,
      to_email: request.to,
      from_name: request.fromName,
      subject: request.subject,
      body_text: request.text,
      body_html: request.html ?? textToHtml(request.text),
      reply_to: request.replyTo ?? request.from,
      ...(request.inReplyTo ? { in_reply_to: request.inReplyTo } : {}),
      ...(request.references?.length ? { references: request.references.join(' ') } : {}),
      ...(request.metadata ? { custom_fields: request.metadata } : {}),
    };

    const response = await this.request('POST', '/emails/send', body);

    const messageId =
      (response as { message_id?: string; id?: string }).message_id ??
      (response as { id?: string }).id;

    if (!messageId) throw new EmailFatalError('Smartlead returned no message id');

    return {
      providerMessageId: String(messageId),
      ...(typeof (response as { thread_id?: string }).thread_id === 'string'
        ? { threadId: (response as { thread_id: string }).thread_id }
        : {}),
      acceptedAt: new Date(),
    };
  }

  /**
   * Smartlead delivers replies as an `EMAIL_REPLY` webhook. It manages inboxes
   * itself, so the reply body and threading come pre-parsed.
   */
  parseInboundEmail(body: unknown): NormalizedInboundEmail | null {
    if (!body || typeof body !== 'object') return null;

    const p = body as {
      event_type?: string;
      from_email?: string;
      to_email?: string;
      subject?: string;
      reply_body?: string;
      reply_message_id?: string;
      in_reply_to?: string;
      time?: string;
    };

    if (p.event_type && p.event_type !== 'EMAIL_REPLY') return null;
    if (!p.from_email || !p.reply_body) return null;

    return {
      fromAddress: p.from_email.trim().toLowerCase(),
      toAddress: (p.to_email ?? '').trim().toLowerCase(),
      subject: p.subject ?? '(no subject)',
      text: p.reply_body,
      ...(p.in_reply_to ? { inReplyTo: p.in_reply_to } : {}),
      references: [],
      ...(p.reply_message_id ? { providerMessageId: p.reply_message_id } : {}),
      receivedAt: p.time ? new Date(p.time) : new Date(),
      raw: body,
    };
  }

  parseWebhook(body: unknown): NormalizedEmailEvent[] {
    if (!body || typeof body !== 'object') return [];

    const payload = body as {
      event_type?: string;
      event_id?: string;
      message_id?: string;
      timestamp?: string;
      bounce_type?: string;
      reason?: string;
    };

    const kind = payload.event_type ? EVENT_MAP[payload.event_type] : undefined;
    const providerMessageId = payload.message_id;
    if (!kind || !providerMessageId) return [];

    const occurredAt = payload.timestamp ? new Date(payload.timestamp) : new Date();

    return [
      {
        providerEventId:
          payload.event_id ??
          `${providerMessageId}:${kind}:${Math.floor(occurredAt.getTime() / 1000)}`,
        providerMessageId,
        kind,
        occurredAt,
        ...(payload.bounce_type ? { bounceType: payload.bounce_type } : {}),
        ...(payload.reason ? { reason: payload.reason } : {}),
        raw: body,
      },
    ];
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    const secret = env.SMARTLEAD_API_KEY;
    const signature = headers['x-smartlead-signature'] ?? headers['x-webhook-signature'];
    if (!secret || !signature) return false;

    try {
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      await this.request('GET', '/email-accounts');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(this.apiKey)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new EmailRetryableError(
        `Smartlead network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new EmailRetryableError(
        'Smartlead rate limit',
        retryAfter ? Number(retryAfter) * 1000 : 60_000,
      );
    }
    if (response.status >= 500) {
      throw new EmailRetryableError(`Smartlead server error (${response.status})`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new EmailFatalError('Smartlead authentication failed — check SMARTLEAD_API_KEY');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new EmailFatalError(`Smartlead error (${response.status}): ${text.slice(0, 300)}`);
    }

    return response.json().catch(() => ({}));
  }
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
