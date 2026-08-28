/**
 * Job: send_email
 *
 * The only place in the system that actually delivers mail. Every guard is
 * re-checked here rather than trusted from the enqueue site, because time passes
 * between approval and send: a contact may have unsubscribed, the daily cap may
 * have filled, or the send window may have closed.
 */

import { db } from '@/db';
import { emails, leads, contacts, organizations, sendingInboxes, settings } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getEmailService } from '@/lib/providers/email';
import {
  selectInboxForSend,
  recordInboxSend,
  isWithinSendWindow,
  NoCapacityError,
} from '@/lib/sending/inbox-rotation';
import { notifyHandled, notifyStopped } from '@/lib/notifications';
import type { JobHandler } from '../types';

export const sendEmailHandler: JobHandler<{ emailId: string; force?: boolean }> = async (job) => {
  const { emailId, force } = job.payload;
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('send_email requires an organizationId');

  const [row] = await db
    .select({ email: emails, lead: leads, contact: contacts })
    .from(emails)
    .innerJoin(leads, eq(emails.leadId, leads.id))
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .where(and(eq(emails.id, emailId), eq(emails.organizationId, organizationId)))
    .limit(1);

  if (!row) throw new Error(`Email ${emailId} not found`);
  const { email, lead, contact } = row;

  // --- Guards, all re-verified at send time -------------------------------

  if (email.status !== 'approved' && email.status !== 'queued') {
    return { skipped: true, reason: `Email status is "${email.status}", not approved` };
  }

  if (!email.approvedBy) {
    // Belt and braces: the status could only be 'approved' via the approval
    // route, but sending without a recorded approver is never acceptable.
    await db
      .update(emails)
      .set({ status: 'draft', failureReason: 'Blocked: no approver recorded', updatedAt: new Date() })
      .where(eq(emails.id, emailId));
    throw new Error('Refusing to send an email with no recorded approver');
  }

  if (contact.isUnsubscribed || contact.isSuppressed) {
    await db
      .update(emails)
      .set({
        status: 'rejected',
        failureReason: 'Contact unsubscribed or suppressed before send',
        updatedAt: new Date(),
      })
      .where(eq(emails.id, emailId));
    return { skipped: true, reason: 'Contact is unsubscribed or suppressed' };
  }

  if (lead.repliedAt && email.kind !== 'initial') {
    await db
      .update(emails)
      .set({ status: 'rejected', failureReason: 'Lead replied before follow-up sent', updatedAt: new Date() })
      .where(eq(emails.id, emailId));
    return { skipped: true, reason: 'Lead already replied' };
  }

  if (!force && !isWithinSendWindow()) {
    // Not a failure — reschedule into the next window rather than burning an attempt.
    // `force` (a manual "send now" / test send) deliberately bypasses the window.
    const nextWindow = nextSendWindowStart();
    await db
      .update(emails)
      .set({ status: 'queued', scheduledFor: nextWindow, updatedAt: new Date() })
      .where(eq(emails.id, emailId));
    return { deferred: true, reason: 'Outside send window', retryAt: nextWindow.toISOString() };
  }

  // --- Capacity -----------------------------------------------------------

  let inbox;
  try {
    inbox = await selectInboxForSend(organizationId);
  } catch (error) {
    if (error instanceof NoCapacityError) {
      const tomorrow = nextSendWindowStart();
      await db
        .update(emails)
        .set({ status: 'queued', scheduledFor: tomorrow, updatedAt: new Date() })
        .where(eq(emails.id, emailId));

      await notifyHandled(organizationId, 'Daily send limit reached', error.message, {
        actionUrl: '/sending/limits',
        actionLabel: 'Review sending limits',
      });

      return { deferred: true, reason: error.message, retryAt: tomorrow.toISOString() };
    }
    throw error;
  }

  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  await db
    .update(emails)
    .set({
      status: 'sending',
      inboxId: inbox.id,
      fromAddress: inbox.emailAddress,
      provider: inbox.provider,
      attemptCount: email.attemptCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(emails.id, emailId));

  // Smartlead sends through a relay campaign (it has no transactional endpoint);
  // the campaign id lives in settings so it can change without a redeploy.
  let relayCampaignId: string | undefined;
  if (inbox.provider === 'smartlead') {
    const [row2] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.organizationId, organizationId),
          eq(settings.key, 'smartlead_relay_campaign_id'),
        ),
      )
      .limit(1);
    if (row2?.value != null) relayCampaignId = String(row2.value);
  }

  try {
    const service = getEmailService(inbox.provider);

    const result = await service.send({
      from: inbox.emailAddress,
      fromName: inbox.displayName || organization?.senderName || inbox.emailAddress,
      to: email.toAddress,
      ...(contact.firstName || contact.fullName
        ? { toName: contact.firstName ?? contact.fullName ?? undefined }
        : {}),
      subject: email.subject,
      text: email.bodyText,
      ...(email.bodyHtml ? { html: email.bodyHtml } : {}),
      ...(inbox.replyToAddress ? { replyTo: inbox.replyToAddress } : {}),
      ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
      ...(email.threadId ? { references: [email.threadId] } : {}),
      ...(inbox.providerInboxId ? { providerInboxId: inbox.providerInboxId } : {}),
      ...(relayCampaignId ? { providerCampaignId: relayCampaignId } : {}),
      metadata: { email_id: emailId, lead_id: email.leadId, kind: email.kind },
    });

    const sentAt = new Date();

    await db
      .update(emails)
      .set({
        status: 'sent',
        sentAt,
        providerMessageId: result.providerMessageId,
        messageIdHeader: result.messageIdHeader ?? result.providerMessageId,
        threadId: email.threadId ?? result.threadId ?? result.providerMessageId,
        failureReason: null,
        updatedAt: sentAt,
      })
      .where(eq(emails.id, emailId));

    await recordInboxSend(inbox.id);
    await advanceLeadAfterSend(email.leadId, email.kind, sentAt, lead.campaignId);

    return {
      sent: true,
      providerMessageId: result.providerMessageId,
      inbox: inbox.emailAddress,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isRecipientProblem = (error as { isRecipientProblem?: boolean })?.isRecipientProblem;

    if (isRecipientProblem) {
      // The address itself is bad. Suppress the contact so no future campaign
      // retries it and damages the domain further.
      await db
        .update(emails)
        .set({ status: 'failed', failureReason: message, updatedAt: new Date() })
        .where(eq(emails.id, emailId));

      await db
        .update(contacts)
        .set({
          isSuppressed: true,
          suppressionReason: `Invalid address: ${message.slice(0, 200)}`,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contact.id));

      await db
        .update(leads)
        .set({ status: 'bounced', lastError: message, updatedAt: new Date() })
        .where(eq(leads.id, email.leadId));

      return { failed: true, suppressed: true, reason: message };
    }

    await db
      .update(emails)
      .set({ status: 'approved', failureReason: message, updatedAt: new Date() })
      .where(eq(emails.id, emailId));

    // Final attempt exhausted — a human needs to look at it.
    if (job.attempts >= job.maxAttempts) {
      await notifyStopped(
        organizationId,
        'Email failed to send',
        `Sending to ${email.toAddress} failed after ${job.attempts} attempts: ${message}`,
        { actionUrl: `/leads/${email.leadId}`, actionLabel: 'Open lead' },
      );
    }

    throw error;
  }
};

/** Move the lead forward and schedule the next follow-up. */
async function advanceLeadAfterSend(
  leadId: string,
  kind: string,
  sentAt: Date,
  campaignId: string | null,
): Promise<void> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return;

  let followUpDelayDays = 4;
  let maxFollowUps = 2;

  if (campaignId) {
    const { campaigns } = await import('@/db/schema');
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (campaign) {
      maxFollowUps = campaign.maxFollowUps;
      followUpDelayDays =
        kind === 'initial' ? campaign.followUp1DelayDays : campaign.followUp2DelayDays;
    }
  }

  const isInitial = kind === 'initial';
  const newFollowUpCount = isInitial ? lead.followUpCount : lead.followUpCount + 1;

  const status = isInitial
    ? 'contacted'
    : newFollowUpCount === 1
      ? 'follow_up_1_sent'
      : 'follow_up_2_sent';

  const hasMoreFollowUps = newFollowUpCount < maxFollowUps;
  const nextFollowUpAt = hasMoreFollowUps
    ? new Date(sentAt.getTime() + followUpDelayDays * 24 * 60 * 60 * 1000)
    : null;

  await db
    .update(leads)
    .set({
      status,
      followUpCount: newFollowUpCount,
      firstContactedAt: lead.firstContactedAt ?? sentAt,
      lastContactedAt: sentAt,
      nextFollowUpAt,
      requiresAttention: false,
      attentionReason: null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, leadId));
}

/** Start of the next weekday send window, in the configured timezone. */
function nextSendWindowStart(): Date {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);

  // Skip Saturday and Sunday.
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}
