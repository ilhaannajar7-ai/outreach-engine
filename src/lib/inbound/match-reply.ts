/**
 * Match an inbound reply back to the outreach that prompted it, and record it.
 *
 * Getting the match right is what makes replies useful: a reply attached to the
 * wrong lead sends the wrong follow-up and misroutes the alert. Two signals are
 * used, strongest first:
 *
 *   1. Threading headers (In-Reply-To / References) → the exact email we sent.
 *      Reliable, because well-behaved mail clients echo our Message-ID.
 *   2. The from-address → the contact, then their most recent sent email.
 *      The fallback for clients that strip headers.
 *
 * A reply that matches nothing is still stored, unlinked, and flagged — a real
 * human reply we could not thread is worth surfacing, not dropping.
 */

import { db } from '@/db';
import { emails, contacts, leads, replies, companies } from '@/db/schema';
import { and, eq, desc, inArray, or, sql as dsql } from 'drizzle-orm';
import type { NormalizedInboundEmail } from '@/lib/providers/email';
import { notify } from '@/lib/notifications';

export interface MatchResult {
  matched: boolean;
  replyId?: string;
  leadId?: string;
  reason: string;
}

/** Automated senders whose mail is never a human reply. */
const SYSTEM_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce[s]?|notifications?|daemon)([+.@]|$)/i;

function isSystemSender(address: string): boolean {
  const local = address.split('@')[0] ?? '';
  return SYSTEM_SENDER.test(local);
}

/** True when the sender's domain belongs to a company or contact on file. */
async function isKnownProspectDomain(organizationId: string, address: string): Promise<boolean> {
  const domain = address.split('@')[1]?.toLowerCase().trim();
  if (!domain) return false;

  const [hit] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(leads, eq(leads.contactId, contacts.id))
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        or(
          dsql`lower(split_part(${contacts.email}, '@', 2)) = ${domain}`,
          dsql`lower(${companies.domain}) = ${domain}`,
        ),
      ),
    )
    .limit(1);

  return Boolean(hit);
}

export async function ingestInboundReply(
  organizationId: string,
  inbound: NormalizedInboundEmail,
): Promise<MatchResult> {
  // --- 1. Match by threading headers ------------------------------------
  const messageIds = [inbound.inReplyTo, ...inbound.references].filter(
    (id): id is string => Boolean(id),
  );

  let matchedEmail: typeof emails.$inferSelect | undefined;

  if (messageIds.length > 0) {
    const candidates = await db
      .select()
      .from(emails)
      .where(
        and(
          eq(emails.organizationId, organizationId),
          or(
            inArray(emails.messageIdHeader, messageIds),
            inArray(emails.providerMessageId, messageIds),
            inArray(emails.threadId, messageIds),
          ),
        ),
      )
      .orderBy(desc(emails.sentAt))
      .limit(1);

    matchedEmail = candidates[0];
  }

  // --- 2. Fall back to the sender's most recent sent email --------------
  if (!matchedEmail && inbound.fromAddress) {
    const [row] = await db
      .select({ email: emails })
      .from(emails)
      .innerJoin(leads, eq(emails.leadId, leads.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(
        and(
          eq(emails.organizationId, organizationId),
          eq(contacts.email, inbound.fromAddress),
          // Every status meaning the message left the building. There is no
          // 'opened' email_status — opens live in open_count.
          inArray(emails.status, ['sent', 'delivered']),
        ),
      )
      .orderBy(desc(emails.sentAt))
      .limit(1);

    matchedEmail = row?.email;
  }

  // --- Unmatched: surface only what could plausibly be a prospect -------
  if (!matchedEmail) {
    // The polled mailbox also receives bounce notices, Smartlead warm-up
    // traffic, and ordinary mail. None of that is a reply, and treating it as
    // one buried every real alert under thousands of repeats: the poller
    // re-reads a lookback window every ten minutes, so each such message was
    // re-announced on every pass.
    if (isSystemSender(inbound.fromAddress)) {
      return { matched: false, reason: 'System/bounce sender — not a reply' };
    }

    // A real prospect replying without threading headers almost always writes
    // from their company's domain. A sender from a domain we have never
    // contacted is not a reply to our outreach.
    if (!(await isKnownProspectDomain(organizationId, inbound.fromAddress))) {
      return { matched: false, reason: 'Sender domain is not a contacted prospect' };
    }

    await notify({
      organizationId,
      tier: 'tier_2_auto_notified',
      title: `Unmatched reply from ${inbound.fromAddress}`,
      message:
        `A reply came in from a prospect's domain but could not be matched to a specific email:\n\n` +
        `Subject: ${inbound.subject}\n\n${inbound.text.slice(0, 400)}`,
      metadata: { fromAddress: inbound.fromAddress, subject: inbound.subject },
      // Announce each message once, however many times the poller re-reads it.
      dedupeKey: `unmatched:${inbound.providerMessageId ?? `${inbound.fromAddress}:${inbound.subject}`}`,
      dedupeWindowHours: 24 * 30,
    });

    return { matched: false, reason: 'No sent email matched the reply' };
  }

  // Idempotency: a provider may deliver the same reply twice. A reply already
  // stored for this exact provider message is a no-op.
  if (inbound.providerMessageId) {
    const [existing] = await db
      .select({ id: replies.id })
      .from(replies)
      .where(
        and(
          eq(replies.organizationId, organizationId),
          eq(replies.providerMessageId, inbound.providerMessageId),
        ),
      )
      .limit(1);

    if (existing) {
      return { matched: true, replyId: existing.id, leadId: matchedEmail.leadId, reason: 'Duplicate' };
    }
  }

  const [reply] = await db
    .insert(replies)
    .values({
      organizationId,
      leadId: matchedEmail.leadId,
      emailId: matchedEmail.id,
      fromAddress: inbound.fromAddress,
      subject: inbound.subject,
      bodyText: inbound.text,
      bodyHtml: inbound.html ?? null,
      classification: 'unclassified',
      providerMessageId: inbound.providerMessageId ?? null,
      receivedAt: inbound.receivedAt,
    })
    .returning();

  // Stop the sequence the moment a human replies — even before classification.
  // A follow-up sent after someone has already written back is the clearest
  // possible sign of an automated, unattended system.
  await db
    .update(leads)
    .set({ repliedAt: new Date(), nextFollowUpAt: null, updatedAt: new Date() })
    .where(eq(leads.id, matchedEmail.leadId));

  return {
    matched: true,
    replyId: reply!.id,
    leadId: matchedEmail.leadId,
    reason: 'Matched and stored',
  };
}
