import { NextResponse } from 'next/server';
import { db } from '@/db';
import { sendingInboxes, organizations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getEmailService } from '@/lib/providers/email';
import { getJobQueue } from '@/lib/providers/queue';
import { ingestInboundReply } from '@/lib/inbound/match-reply';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Inbound email webhook — a prospect's reply arrives here.
 *
 * This closes the loop: the reply is matched to the outreach that prompted it,
 * stored, and queued for classification, which routes it (interested → alert a
 * human; unsubscribe → suppress). Unauthenticated by necessity — the provider
 * calls it — so the signature check is the gate.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const service = getEmailService();

  // The console provider only runs in local dev and has no signature; every
  // real provider must pass verification. Production never skips it.
  const isConsoleDev = service.name === 'console' && env.NODE_ENV !== 'production';
  if (!isConsoleDev && !service.verifyWebhookSignature(rawBody, headers)) {
    console.warn('[inbound] rejected a reply webhook with an invalid signature');
    return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const inbound = service.parseInboundEmail(payload, headers);
  if (!inbound) {
    // Not a parseable inbound message (a delivery event hitting the wrong URL,
    // a provider ping). Acknowledge so the provider stops retrying.
    return NextResponse.json({ ok: true, processed: 0 });
  }

  // Resolve the org from the recipient — the reply's `to` is one of our sending
  // addresses. Falls back to the sole org in a single-tenant install.
  const organizationId = await resolveOrganization(inbound.toAddress);
  if (!organizationId) {
    console.warn(`[inbound] could not resolve an org for recipient ${inbound.toAddress}`);
    return NextResponse.json({ ok: true, processed: 0, note: 'No matching organization' });
  }

  const result = await ingestInboundReply(organizationId, inbound);

  // Queue classification only for a reply we actually stored.
  if (result.matched && result.replyId && result.reason !== 'Duplicate') {
    await getJobQueue().enqueue(
      'classify_reply',
      { replyId: result.replyId },
      { organizationId, idempotencyKey: `classify:${result.replyId}` },
    );
  }

  return NextResponse.json({ ok: true, matched: result.matched, reason: result.reason });
}

/**
 * Which organization owns the inbox this reply was sent to.
 *
 * Matching on the recipient address is the multi-tenant-correct answer; the
 * single-org fallback keeps V1 working before any inbox is registered.
 */
async function resolveOrganization(toAddress: string): Promise<string | null> {
  if (toAddress) {
    const [inbox] = await db
      .select({ organizationId: sendingInboxes.organizationId })
      .from(sendingInboxes)
      .where(eq(sendingInboxes.emailAddress, toAddress))
      .limit(1);
    if (inbox) return inbox.organizationId;
  }

  const orgs = await db.select({ id: organizations.id }).from(organizations).limit(2);
  // Only fall back when there is exactly one org — guessing across tenants would
  // attach a reply to the wrong account.
  return orgs.length === 1 ? orgs[0]!.id : null;
}
