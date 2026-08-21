import { NextResponse } from 'next/server';
import { db } from '@/db';
import { emails, emailEvents, contacts, leads, sendingInboxes } from '@/db/schema';
import { eq, sql as dsql } from 'drizzle-orm';
import { getEmailService } from '@/lib/providers/email';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Email provider webhook.
 *
 * Unauthenticated by necessity — the provider calls it — so the signature check
 * is the only thing standing between this endpoint and forged events. It runs
 * before the body is parsed as anything meaningful, and a failure returns 401
 * without touching the database.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const service = getEmailService();

  if (!service.verifyWebhookSignature(rawBody, headers)) {
    console.warn('[webhook] rejected an email webhook with an invalid signature');
    return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const events = service.parseWebhook(payload, headers);
  if (events.length === 0) {
    // Unmapped event types are normal — acknowledge so the provider stops retrying.
    return NextResponse.json({ ok: true, processed: 0 });
  }

  let processed = 0;

  for (const event of events) {
    const [email] = await db
      .select()
      .from(emails)
      .where(eq(emails.providerMessageId, event.providerMessageId))
      .limit(1);

    if (!email) continue;

    // The unique index on (provider, provider_event_id) makes replayed webhooks
    // a no-op rather than a double count.
    const inserted = await db
      .insert(emailEvents)
      .values({
        organizationId: email.organizationId,
        emailId: email.id,
        eventType: event.kind,
        provider: service.name,
        providerEventId: event.providerEventId,
        payload: event.raw as Record<string, unknown>,
        bounceType: event.bounceType ?? null,
        reason: event.reason ?? null,
        occurredAt: event.occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: emailEvents.id });

    if (inserted.length === 0) continue;
    processed++;

    await applyEvent(email, event);
  }

  return NextResponse.json({ ok: true, processed });
}

async function applyEvent(
  email: typeof emails.$inferSelect,
  event: { kind: string; reason?: string; bounceType?: string },
): Promise<void> {
  const now = new Date();

  switch (event.kind) {
    case 'delivered':
      await db
        .update(emails)
        .set({ status: 'delivered', updatedAt: now })
        .where(eq(emails.id, email.id));
      break;

    case 'opened':
      await db
        .update(emails)
        .set({ openCount: dsql`${emails.openCount} + 1`, updatedAt: now })
        .where(eq(emails.id, email.id));
      break;

    case 'clicked':
      await db
        .update(emails)
        .set({ clickCount: dsql`${emails.clickCount} + 1`, updatedAt: now })
        .where(eq(emails.id, email.id));
      break;

    case 'bounced': {
      await db
        .update(emails)
        .set({ status: 'bounced', failureReason: event.reason ?? 'Bounced', updatedAt: now })
        .where(eq(emails.id, email.id));

      if (email.inboxId) {
        await db
          .update(sendingInboxes)
          .set({ totalBounced: dsql`${sendingInboxes.totalBounced} + 1`, updatedAt: now })
          .where(eq(sendingInboxes.id, email.inboxId));
      }

      // Only a hard bounce means the address is permanently bad. Soft bounces
      // (full mailbox, temporary outage) must not suppress a valid contact.
      if (event.bounceType === 'hard' || event.bounceType === 'Permanent') {
        const [lead] = await db.select().from(leads).where(eq(leads.id, email.leadId)).limit(1);
        if (lead) {
          await db
            .update(contacts)
            .set({
              isSuppressed: true,
              suppressionReason: `Hard bounce: ${event.reason ?? 'address rejected'}`,
              updatedAt: now,
            })
            .where(eq(contacts.id, lead.contactId));

          await db
            .update(leads)
            .set({ status: 'bounced', nextFollowUpAt: null, updatedAt: now })
            .where(eq(leads.id, email.leadId));
        }
      }
      break;
    }

    case 'complained': {
      // A spam complaint is the most damaging signal there is. Suppress the
      // contact permanently and stop the sequence immediately.
      await db
        .update(emails)
        .set({ status: 'complained', updatedAt: now })
        .where(eq(emails.id, email.id));

      if (email.inboxId) {
        await db
          .update(sendingInboxes)
          .set({ totalComplaints: dsql`${sendingInboxes.totalComplaints} + 1`, updatedAt: now })
          .where(eq(sendingInboxes.id, email.inboxId));
      }

      const [lead] = await db.select().from(leads).where(eq(leads.id, email.leadId)).limit(1);
      if (lead) {
        await db
          .update(contacts)
          .set({
            isUnsubscribed: true,
            unsubscribedAt: now,
            isSuppressed: true,
            suppressionReason: 'Marked the email as spam',
            updatedAt: now,
          })
          .where(eq(contacts.id, lead.contactId));

        await db
          .update(leads)
          .set({ status: 'unsubscribed', nextFollowUpAt: null, updatedAt: now })
          .where(eq(leads.id, email.leadId));
      }
      break;
    }

    case 'unsubscribed': {
      const [lead] = await db.select().from(leads).where(eq(leads.id, email.leadId)).limit(1);
      if (lead) {
        await db
          .update(contacts)
          .set({
            isUnsubscribed: true,
            unsubscribedAt: now,
            isSuppressed: true,
            suppressionReason: 'Used the unsubscribe link',
            updatedAt: now,
          })
          .where(eq(contacts.id, lead.contactId));

        await db
          .update(leads)
          .set({ status: 'unsubscribed', nextFollowUpAt: null, updatedAt: now })
          .where(eq(leads.id, email.leadId));
      }
      break;
    }

    case 'failed':
      await db
        .update(emails)
        .set({ status: 'failed', failureReason: event.reason ?? 'Delivery failed', updatedAt: now })
        .where(eq(emails.id, email.id));
      break;
  }
}
