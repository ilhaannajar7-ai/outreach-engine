/**
 * IMAP reply polling.
 *
 * The reliable path for catching replies. The sending provider (Smartlead)
 * delivers reply webhooks for campaign sends, but this app sends through the
 * direct API, so those webhooks may never fire. Replies still physically land
 * in the mailbox, though — so we read them straight from it over IMAP and feed
 * each one through the same ingestInboundReply path a webhook would use.
 *
 * Credentials reuse the SMTP mailbox login (same Zoho account) unless IMAP_USER
 * / IMAP_PASSWORD override them. Only messages newer than a lookback window are
 * examined, and each is matched to outreach by threading headers, so a normal
 * personal email to the mailbox is ignored rather than logged as a "reply".
 *
 * Single-mailbox by design for now: it polls one inbox. Multiple sending
 * mailboxes would each need their own IMAP credentials on the inbox row.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db } from '@/db';
import { organizations, sendingInboxes } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { env } from '@/lib/env';
import { ingestInboundReply } from '@/lib/inbound/match-reply';
import { getJobQueue } from '@/lib/providers/queue';
import type { NormalizedInboundEmail } from '@/lib/providers/email/types';

export interface PollResult {
  examined: number;
  matched: number;
  skipped: number;
  error?: string;
}

/** How far back to look each run — generous enough to survive a missed run. */
const LOOKBACK_HOURS = 26;

export function imapConfigured(): boolean {
  const user = env.IMAP_USER ?? env.SMTP_USER;
  const pass = env.IMAP_PASSWORD ?? env.SMTP_PASSWORD;
  return env.IMAP_ENABLED && Boolean(user && pass && env.IMAP_HOST);
}

export async function pollInboxForReplies(organizationId: string): Promise<PollResult> {
  const user = env.IMAP_USER ?? env.SMTP_USER;
  const pass = env.IMAP_PASSWORD ?? env.SMTP_PASSWORD;

  if (!env.IMAP_ENABLED) return { examined: 0, matched: 0, skipped: 0, error: 'IMAP disabled' };
  if (!user || !pass) {
    return { examined: 0, matched: 0, skipped: 0, error: 'No IMAP credentials' };
  }

  const client = new ImapFlow({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    secure: env.IMAP_PORT === 993,
    auth: { user, pass },
    logger: false,
  });

  let examined = 0;
  let matched = 0;
  let skipped = 0;

  try {
    await client.connect();
  } catch (error) {
    return {
      examined: 0,
      matched: 0,
      skipped: 0,
      error: `IMAP connect failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const queue = getJobQueue();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

    // `since` is day-granular in IMAP, so this over-selects slightly; the
    // threading match and the reply de-dupe downstream discard the extras.
    for await (const message of client.fetch(
      { since },
      { envelope: true, source: true, internalDate: true },
    )) {
      examined += 1;
      if (!message.source) {
        skipped += 1;
        continue;
      }
      try {
        const parsed = await simpleParser(message.source as Buffer);

        const references = normalizeRefs(parsed.references);
        const inReplyTo = firstMessageId(parsed.inReplyTo);

        // No threading headers means this was not a reply to something we sent
        // (a cold personal email, a newsletter). ingestInboundReply also guards
        // on this, but skipping here avoids the work.
        if (!inReplyTo && references.length === 0) {
          skipped += 1;
          continue;
        }

        const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase() ?? '';
        const toAddress =
          (Array.isArray(parsed.to) ? parsed.to[0] : parsed.to)?.value?.[0]?.address?.toLowerCase() ??
          user.toLowerCase();

        const inbound: NormalizedInboundEmail = {
          fromAddress,
          toAddress,
          subject: parsed.subject ?? '(no subject)',
          text: parsed.text ?? '',
          ...(parsed.html ? { html: parsed.html } : {}),
          ...(inReplyTo ? { inReplyTo } : {}),
          references,
          ...(parsed.messageId ? { providerMessageId: parsed.messageId } : {}),
          receivedAt: new Date(message.internalDate ?? parsed.date ?? Date.now()),
          raw: { source: 'imap', uid: message.uid },
        };

        const result = await ingestInboundReply(organizationId, inbound);
        if (result.matched && result.replyId && result.reason !== 'Duplicate') {
          matched += 1;
          await queue.enqueue(
            'classify_reply',
            { replyId: result.replyId },
            { organizationId, idempotencyKey: `classify:${result.replyId}` },
          );
        } else {
          skipped += 1;
        }
      } catch {
        // One unparseable message must not abort the whole run.
        skipped += 1;
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return { examined, matched, skipped };
}

/** The org that owns the polled mailbox — the single org in this install. */
export async function resolvePollOrganization(): Promise<string | null> {
  const user = (env.IMAP_USER ?? env.SMTP_USER)?.toLowerCase();
  if (user) {
    const [inbox] = await db
      .select({ organizationId: sendingInboxes.organizationId })
      .from(sendingInboxes)
      .where(eq(sendingInboxes.emailAddress, user))
      .limit(1);
    if (inbox) return inbox.organizationId;
  }
  const orgs = await db.select({ id: organizations.id }).from(organizations).limit(2);
  return orgs.length === 1 ? orgs[0]!.id : null;
}

function normalizeRefs(refs: string | string[] | undefined): string[] {
  if (!refs) return [];
  const list = Array.isArray(refs) ? refs : refs.split(/\s+/);
  return list.map((r) => r.trim()).filter(Boolean);
}

function firstMessageId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
