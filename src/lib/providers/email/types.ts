/**
 * Email provider contract.
 *
 * This is the interface that makes the Phase 1 → Phase 3 scaling path a config
 * change. Resend today, Smartlead at 500/day, SES at 2000/day — the send job,
 * the approval UI, and the webhook handler never change.
 */

export interface SendEmailRequest {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;

  /** Threading headers so follow-ups land in the same conversation. */
  inReplyTo?: string;
  references?: string[];

  /** Echoed back on webhook events so we can match an event to our row. */
  metadata?: Record<string, string>;

  /** Provider-side mailbox id, when the provider manages inboxes (Smartlead). */
  providerInboxId?: string;
}

export interface SendEmailResult {
  providerMessageId: string;
  messageIdHeader?: string;
  threadId?: string;
  acceptedAt: Date;
}

export type EmailEventKind =
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'complained'
  | 'unsubscribed'
  | 'failed';

export interface NormalizedEmailEvent {
  providerEventId: string;
  providerMessageId: string;
  kind: EmailEventKind;
  occurredAt: Date;
  /** 'hard' | 'soft' | 'block' — drives whether the contact is suppressed. */
  bounceType?: string;
  reason?: string;
  raw: unknown;
}

/**
 * A parsed inbound email — a prospect's reply.
 *
 * This is how a reply enters the system. The threading headers are what match
 * it back to the outreach that prompted it; the from-address is the fallback
 * when a mail client strips them.
 */
export interface NormalizedInboundEmail {
  fromAddress: string;
  toAddress: string;
  subject: string;
  text: string;
  html?: string;
  /** The Message-ID of the email being replied to, if present. */
  inReplyTo?: string;
  /** Full References chain, oldest first. */
  references: string[];
  /** The provider's own id for this inbound message, for idempotency. */
  providerMessageId?: string;
  receivedAt: Date;
  raw: unknown;
}

export interface EmailService {
  readonly name: string;

  send(request: SendEmailRequest): Promise<SendEmailResult>;

  /**
   * Turn a provider webhook body into our event shape. Returns [] for payloads
   * this provider does not map to anything we track.
   */
  parseWebhook(body: unknown, headers: Record<string, string>): NormalizedEmailEvent[];

  /**
   * Turn an inbound-email webhook body into a reply. Returns null for a payload
   * that is not a parseable inbound message. Providers that do not deliver
   * inbound mail (console) return null.
   */
  parseInboundEmail(body: unknown, headers: Record<string, string>): NormalizedInboundEmail | null;

  /** Verify the webhook signature. Must return false rather than throw. */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean;

  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

export class EmailRetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'EmailRetryableError';
  }
}

export class EmailFatalError extends Error {
  constructor(
    message: string,
    /** True when the recipient address itself is the problem — suppress, don't retry. */
    readonly isRecipientProblem = false,
  ) {
    super(message);
    this.name = 'EmailFatalError';
  }
}
