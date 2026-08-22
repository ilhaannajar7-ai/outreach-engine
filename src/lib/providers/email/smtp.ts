/**
 * SMTP implementation of EmailService.
 *
 * Sends directly through an SMTP server (e.g. Zoho, Google Workspace) using the
 * mailbox's own credentials. Unlike Resend/Smartlead there is no HTTP webhook,
 * so delivery events and inbound replies never come back to us over SMTP —
 * parseWebhook/parseInboundEmail are no-ops. Detecting replies for an SMTP inbox
 * needs IMAP polling (not implemented): watch the mailbox, or move the inbox to
 * a webhook provider once one is configured.
 *
 * Credentials are global (SMTP_HOST/PORT/USER/PASSWORD) — one authenticated
 * mailbox. Multiple SMTP inboxes with distinct logins would need per-inbox
 * credentials on the sending_inboxes row; that is a deliberate later step.
 */

import { randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '@/lib/env';
import {
  type EmailService,
  type SendEmailRequest,
  type SendEmailResult,
  type NormalizedEmailEvent,
  type NormalizedInboundEmail,
  EmailRetryableError,
  EmailFatalError,
} from './types';

export class SmtpEmailService implements EmailService {
  readonly name = 'smtp';
  private transporter: Transporter | null = null;

  /** Lazily build and cache the transport so a bad config fails at send time. */
  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const host = env.SMTP_HOST;
    const user = env.SMTP_USER;
    const pass = env.SMTP_PASSWORD;
    if (!host || !user || !pass) {
      throw new EmailFatalError(
        'SMTP provider requires SMTP_HOST, SMTP_USER, and SMTP_PASSWORD to be set.',
      );
    }
    const port = env.SMTP_PORT ?? 465;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; 587/25 upgrade via STARTTLS.
      secure: port === 465,
      auth: { user, pass },
    });
    return this.transporter;
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    const transporter = this.getTransporter();

    // Own the Message-ID so a follow-up threads against a value we recorded,
    // rather than depending on whatever the server happens to echo back.
    const domain = request.from.split('@')[1] ?? 'localhost';
    const messageId = `<${randomUUID()}@${domain}>`;

    try {
      const info = await transporter.sendMail({
        from: { name: request.fromName, address: request.from },
        to: request.to,
        subject: request.subject,
        text: request.text,
        ...(request.html ? { html: request.html } : {}),
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
        ...(request.inReplyTo ? { inReplyTo: request.inReplyTo } : {}),
        ...(request.references?.length ? { references: request.references } : {}),
        messageId,
      });

      // Every recipient refused but the server did not throw — treat as fatal
      // for this address so it is suppressed rather than retried forever.
      if (info.rejected?.length && !info.accepted?.length) {
        throw new EmailFatalError(
          `SMTP server rejected all recipients: ${info.rejected.join(', ')}`,
          true,
        );
      }

      const finalId = info.messageId || messageId;
      return {
        providerMessageId: finalId,
        messageIdHeader: finalId,
        acceptedAt: new Date(),
      };
    } catch (error) {
      if (error instanceof EmailRetryableError || error instanceof EmailFatalError) throw error;
      throw this.normalizeError(error);
    }
  }

  parseWebhook(): NormalizedEmailEvent[] {
    // SMTP has no delivery webhooks.
    return [];
  }

  parseInboundEmail(): NormalizedInboundEmail | null {
    // Replies to an SMTP inbox arrive in the mailbox itself, not over SMTP.
    // Detecting them needs IMAP polling (not implemented) — watch the inbox,
    // or move the inbox to a webhook provider (Resend/Smartlead).
    return null;
  }

  verifyWebhookSignature(): boolean {
    return false;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      await this.getTransporter().verify();
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
    const code = (error as { code?: string }).code ?? '';
    const responseCode = (error as { responseCode?: number }).responseCode;

    // Authentication / config — never retryable.
    if (code === 'EAUTH' || /535|534|authenticat|password|credential/i.test(message)) {
      return new EmailFatalError(
        `SMTP authentication failed — check SMTP_USER / SMTP_PASSWORD ` +
          `(Zoho requires an app-specific password): ${message}`,
      );
    }

    // Bad recipient — suppress, don't retry.
    if (
      (responseCode && [550, 551, 553, 554].includes(responseCode)) ||
      /no such user|user unknown|mailbox unavailable|recipient.*reject|invalid.*(recipient|address)/i.test(
        message,
      )
    ) {
      return new EmailFatalError(`SMTP rejected recipient: ${message}`, true);
    }

    // Transient network / connection issues — retry.
    if (
      ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET', 'EENVELOPE'].includes(code) ||
      /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|try again|temporar/i.test(message)
    ) {
      return new EmailRetryableError(`SMTP transient error: ${message}`);
    }

    // 4xx SMTP replies are temporary (greylisting, rate limits) — retry.
    if (responseCode && responseCode >= 400 && responseCode < 500) {
      return new EmailRetryableError(`SMTP temporary failure (${responseCode}): ${message}`, 60_000);
    }

    // 5xx and anything else — permanent.
    return new EmailFatalError(`SMTP error: ${message}`);
  }
}
