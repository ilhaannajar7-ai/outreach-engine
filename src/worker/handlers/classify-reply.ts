/**
 * Job: classify_reply
 *
 * The AI reads an incoming reply and decides where it goes. It never writes a
 * response — routing only. An "interested" reply stops the sequence and alerts
 * a human immediately; an unsubscribe request suppresses the contact forever.
 */

import { db } from '@/db';
import { replies, leads, contacts, emails, companies } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { classifyReply } from '@/lib/ai/operations';
import { notifyStopped, notifyHandled } from '@/lib/notifications';
import type { JobHandler } from '../types';

export const classifyReplyHandler: JobHandler<{ replyId: string }> = async (job) => {
  const { replyId } = job.payload;
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('classify_reply requires an organizationId');

  const [row] = await db
    .select({ reply: replies, lead: leads, contact: contacts, company: companies })
    .from(replies)
    .innerJoin(leads, eq(replies.leadId, leads.id))
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .where(and(eq(replies.id, replyId), eq(replies.organizationId, organizationId)))
    .limit(1);

  if (!row) throw new Error(`Reply ${replyId} not found`);
  const { reply, lead, contact, company } = row;

  if (reply.classification !== 'unclassified') {
    return { skipped: true, reason: 'Already classified' };
  }

  const [sentEmail] = await db
    .select()
    .from(emails)
    .where(and(eq(emails.leadId, lead.id), eq(emails.status, 'sent')))
    .orderBy(desc(emails.sentAt))
    .limit(1);

  const { data, meta } = await classifyReply({
    organizationId,
    leadId: lead.id,
    sentEmail: {
      subject: sentEmail?.subject ?? '(unknown)',
      body: sentEmail?.bodyText ?? '(unknown)',
    },
    reply: { from: reply.fromAddress, subject: reply.subject, body: reply.bodyText },
  });

  await db
    .update(replies)
    .set({
      classification: data.classification,
      classificationConfidence: data.confidence.toFixed(3),
      classificationReasoning: data.reasoning,
      summary: data.summary,
      model: meta.model,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      costUsd: meta.costUsd.toFixed(6),
    })
    .where(eq(replies.id, replyId));

  await route(data.classification, {
    organizationId,
    leadId: lead.id,
    contactId: contact.id,
    companyName: company.name,
    contactName: contact.fullName ?? contact.email,
    summary: data.summary,
    suggestedAction: data.suggested_action,
    confidence: data.confidence,
  });

  return {
    classification: data.classification,
    confidence: data.confidence,
    costUsd: meta.costUsd,
  };
};

async function route(
  classification: string,
  ctx: {
    organizationId: string;
    leadId: string;
    contactId: string;
    companyName: string;
    contactName: string;
    summary: string;
    suggestedAction: string;
    confidence: number;
  },
): Promise<void> {
  const now = new Date();

  switch (classification) {
    case 'interested': {
      // Highest-value event in the system. Stop the sequence, alert immediately.
      await db
        .update(leads)
        .set({
          status: 'interested',
          nextFollowUpAt: null,
          requiresAttention: true,
          attentionReason: `Positive reply — ${ctx.suggestedAction}`,
          updatedAt: now,
        })
        .where(eq(leads.id, ctx.leadId));

      await notifyStopped(
        ctx.organizationId,
        `Interested: ${ctx.companyName}`,
        `${ctx.contactName} replied with interest.\n\n${ctx.summary}\n\nSuggested next step: ${ctx.suggestedAction}`,
        { actionUrl: `/leads/${ctx.leadId}`, actionLabel: 'Open lead and reply' },
      );
      break;
    }

    case 'not_interested': {
      await db
        .update(leads)
        .set({
          status: 'not_interested',
          nextFollowUpAt: null,
          requiresAttention: false,
          attentionReason: null,
          updatedAt: now,
        })
        .where(eq(leads.id, ctx.leadId));
      break;
    }

    case 'unsubscribe_request': {
      // Permanent and global — this contact is never emailed again by any campaign.
      await db
        .update(contacts)
        .set({
          isUnsubscribed: true,
          unsubscribedAt: now,
          isSuppressed: true,
          suppressionReason: 'Requested unsubscribe in a reply',
          updatedAt: now,
        })
        .where(eq(contacts.id, ctx.contactId));

      await db
        .update(leads)
        .set({
          status: 'unsubscribed',
          nextFollowUpAt: null,
          requiresAttention: false,
          updatedAt: now,
        })
        .where(eq(leads.id, ctx.leadId));

      await notifyHandled(
        ctx.organizationId,
        `Unsubscribe honoured: ${ctx.companyName}`,
        `${ctx.contactName} asked to be removed. The contact is suppressed and will not be emailed again.`,
      );
      break;
    }

    case 'wrong_person': {
      await db
        .update(leads)
        .set({
          status: 'replied',
          nextFollowUpAt: null,
          requiresAttention: true,
          attentionReason: `Wrong contact — ${ctx.suggestedAction}`,
          updatedAt: now,
        })
        .where(eq(leads.id, ctx.leadId));

      await notifyHandled(
        ctx.organizationId,
        `Wrong contact at ${ctx.companyName}`,
        `${ctx.summary}\n\nSuggested: ${ctx.suggestedAction}`,
        { actionUrl: `/leads/${ctx.leadId}`, actionLabel: 'Open lead' },
      );
      break;
    }

    case 'out_of_office': {
      // Pause, do not stop. Resume in a week.
      await db
        .update(leads)
        .set({
          nextFollowUpAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          requiresAttention: false,
          updatedAt: now,
        })
        .where(eq(leads.id, ctx.leadId));
      break;
    }

    case 'maybe': {
      await db
        .update(leads)
        .set({
          status: 'replied',
          requiresAttention: true,
          attentionReason: `Soft positive — ${ctx.suggestedAction}`,
          updatedAt: now,
        })
        .where(eq(leads.id, ctx.leadId));

      await notifyHandled(
        ctx.organizationId,
        `Reply from ${ctx.companyName}`,
        `${ctx.summary}\n\nSuggested: ${ctx.suggestedAction}`,
        { actionUrl: `/leads/${ctx.leadId}`, actionLabel: 'Open lead' },
      );
      break;
    }

    case 'auto_reply':
      // Nothing to do — sequence continues on schedule.
      break;

    default: {
      // 'unclassified' — the model was not confident. A human decides.
      await db
        .update(leads)
        .set({
          status: 'replied',
          requiresAttention: true,
          attentionReason: 'Reply needs human review — classification was not confident',
          updatedAt: now,
        })
        .where(eq(leads.id, ctx.leadId));

      await notifyHandled(
        ctx.organizationId,
        `Reply needs review: ${ctx.companyName}`,
        `The classifier was not confident (${(ctx.confidence * 100).toFixed(0)}%). Please read it yourself.`,
        { actionUrl: `/leads/${ctx.leadId}`, actionLabel: 'Read reply' },
      );
    }
  }
}
