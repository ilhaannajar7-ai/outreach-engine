/**
 * Jobs: generate_email, generate_follow_up
 *
 * Both produce a DRAFT only. Nothing here sends anything — the draft lands in
 * `pending_approval` and waits for a human. That gate is the core safety
 * property of the whole system and must never be bypassed.
 */

import { db } from '@/db';
import {
  leads,
  companies,
  contacts,
  organizations,
  aiResearch,
  emails,
  campaigns,
  strategyVariants,
} from '@/db/schema';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { generateEmail, generateFollowUp } from '@/lib/ai/operations';
import { normalizeHooks, HOOK_QUALITY_THRESHOLD } from '@/lib/ai/hook-quality';
import { variantPromptAdditions } from '@/lib/experiments';
import { notify, notifyStopped } from '@/lib/notifications';
import type { JobHandler } from '../types';

/**
 * Campaign + variant guidance for the prompt, layered weakest first because
 * later lines win: campaign tone applies to every lead, campaign additions
 * refine it, and the variant's instructions are what differ between arms.
 *
 * Shared by the initial email and its follow-ups so an A/B arm keeps its voice
 * for the whole sequence — otherwise the test only ever measures email one.
 */
function buildCampaignInstructions(ctx: {
  campaign?: { toneInstructions?: string | null; customPromptAdditions?: string | null } | null;
  variant?: Parameters<typeof variantPromptAdditions>[0];
}): string | null {
  return (
    [
      ctx.campaign?.toneInstructions?.trim()
        ? `Tone for this campaign: ${ctx.campaign.toneInstructions.trim()}`
        : '',
      ctx.campaign?.customPromptAdditions ?? '',
      variantPromptAdditions(ctx.variant ?? null),
    ]
      .filter(Boolean)
      .join('\n\n') || null
  );
}

/** Load every row the generators need, scoped to the org. */
async function loadLeadContext(organizationId: string, leadId: string) {
  const [row] = await db
    .select({
      lead: leads,
      company: companies,
      contact: contacts,
      research: aiResearch,
      campaign: campaigns,
      variant: strategyVariants,
    })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(aiResearch, eq(leads.researchId, aiResearch.id))
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .leftJoin(strategyVariants, eq(leads.variantId, strategyVariants.id))
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!row) throw new Error(`Lead ${leadId} not found`);

  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return { ...row, organization };
}

export const generateEmailHandler: JobHandler<{ leadId: string; allowWeakHook?: boolean }> = async (
  job,
) => {
  const { leadId, allowWeakHook } = job.payload;
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('generate_email requires an organizationId');

  const ctx = await loadLeadContext(organizationId, leadId);

  if (!ctx.research) {
    throw new Error('Lead has no research brief. Run research before generating an email.');
  }
  if (ctx.contact.isUnsubscribed || ctx.contact.isSuppressed) {
    return { skipped: true, reason: 'Contact is unsubscribed or suppressed' };
  }

  // A draft already awaiting approval must not be silently replaced — the human
  // may be mid-review.
  const [existing] = await db
    .select({ id: emails.id })
    .from(emails)
    .where(
      and(
        eq(emails.leadId, leadId),
        eq(emails.kind, 'initial'),
        eq(emails.status, 'pending_approval'),
      ),
    )
    .limit(1);

  if (existing) {
    return { skipped: true, reason: 'A draft is already pending approval', emailId: existing.id };
  }

  // Refuse to write from research with no company-specific hook. The email
  // would open on a generic line, which is the clearest tell that a message was
  // automated — and it costs domain reputation to send. Better to stop here and
  // ask for a real signal than to spend the AI call and the send.
  const hooks = normalizeHooks(ctx.research.personalizationHooks);
  const bestScore = hooks[0]?.score ?? 0;

  // Weak hook handling. The automatic pipeline stops here — sending generic mail
  // at scale is what burns a domain. But a manual "Generate email" click sets
  // allowWeakHook, because the operator explicitly asked for a draft to review
  // and edit, and nothing sends without their approval regardless.
  if (bestScore < HOOK_QUALITY_THRESHOLD && !allowWeakHook) {
    await db
      .update(leads)
      .set({
        status: 'researched',
        requiresAttention: true,
        attentionReason:
          'Research has no company-specific hook, so any email would read as automated. ' +
          'Add a real hiring signal or description and re-run research, or use "Generate email" ' +
          'on the lead to draft one anyway for manual editing.',
        updatedAt: new Date(),
      })
      .where(eq(leads.id, leadId));

    // Make the skip visible instead of silently producing nothing.
    await notify({
      organizationId,
      tier: 'tier_2_auto_notified',
      title: `No email generated: ${ctx.company.name}`,
      message:
        `Generation was skipped — research found no company-specific hook (best score ${bestScore}/100). ` +
        'Add a specific signal (a role, a number, or a date) and re-run research, or open the lead ' +
        'and click "Generate email" to draft one anyway for manual review.',
      relatedEntityType: 'lead',
      relatedEntityId: leadId,
      actionUrl: `/leads/${leadId}`,
      actionLabel: 'Open lead',
    });

    return {
      skipped: true,
      reason: 'No hook scored above the quality threshold',
      bestHookScore: bestScore,
    };
  }

  await db
    .update(leads)
    .set({ status: 'generating', updatedAt: new Date() })
    .where(eq(leads.id, leadId));

  try {
    const { data, meta } = await generateEmail({
      organizationId,
      leadId,
      companyId: ctx.company.id,
      contact: {
        fullName: ctx.contact.fullName,
        firstName: ctx.contact.firstName,
        jobTitle: ctx.contact.jobTitle,
      },
      company: { name: ctx.company.name, hiringSignal: ctx.company.hiringSignal },
      research: {
        summary: ctx.research.summary,
        painPoints: ctx.research.painPoints,
        opportunities: ctx.research.opportunities,
        hooks,
        valueProposition: ctx.research.valueProposition,
      },
      organization: {
        servicesOffered: ctx.organization?.servicesOffered ?? null,
        valueProposition: ctx.organization?.valueProposition ?? null,
        senderName: ctx.organization?.senderName ?? null,
        senderTitle: ctx.organization?.senderTitle ?? null,
        calendarLink: ctx.organization?.calendarLink ?? null,
      },
      campaignInstructions: buildCampaignInstructions(ctx),
    });

    const [email] = await db
      .insert(emails)
      .values({
        organizationId,
        leadId,
        kind: 'initial',
        status: 'pending_approval',
        subject: data.subject,
        bodyText: data.body,
        originalSubject: data.subject,
        originalBodyText: data.body,
        toAddress: ctx.contact.email,
        model: meta.model,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        costUsd: meta.costUsd.toFixed(6),
      })
      .returning({ id: emails.id });

    await db
      .update(leads)
      .set({ status: 'ready_to_contact', lastError: null, updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    return {
      emailId: email!.id,
      costUsd: meta.costUsd,
      model: meta.model,
      personalizationNote: data.personalization_note,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await db
      .update(leads)
      .set({ status: 'error', lastError: message, updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    if ((error as { name?: string }).name === 'BudgetExceededError') {
      await notifyStopped(
        organizationId,
        'AI budget limit reached',
        `Email generation for ${ctx.company.name} was blocked. ${message}`,
        { actionUrl: '/settings/ai', actionLabel: 'Review AI budget' },
      );
    }

    throw error;
  }
};

export const generateFollowUpHandler: JobHandler<{ leadId: string }> = async (job) => {
  const { leadId } = job.payload;
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('generate_follow_up requires an organizationId');

  const ctx = await loadLeadContext(organizationId, leadId);

  if (ctx.contact.isUnsubscribed || ctx.contact.isSuppressed) {
    return { skipped: true, reason: 'Contact is unsubscribed or suppressed' };
  }
  if (ctx.lead.repliedAt) {
    return { skipped: true, reason: 'Lead already replied — sequence stops' };
  }

  const maxFollowUps = ctx.campaign?.maxFollowUps ?? 3;
  const followUpNumber = ctx.lead.followUpCount + 1;

  if (followUpNumber > maxFollowUps) {
    await db
      .update(leads)
      .set({ status: 'closed', nextFollowUpAt: null, updatedAt: new Date() })
      .where(eq(leads.id, leadId));
    return { skipped: true, reason: `Already sent ${maxFollowUps} follow-ups` };
  }

  // 'sent' is only the status until the delivery webhook lands — a delivered
  // email is still one we sent. Matching 'sent' alone loses the thread the
  // moment the provider confirms delivery.
  const sentEmails = await db
    .select()
    .from(emails)
    .where(and(eq(emails.leadId, leadId), inArray(emails.status, ['sent', 'delivered'])))
    .orderBy(emails.createdAt);

  const original = sentEmails.find((e) => e.kind === 'initial');
  if (!original) {
    throw new Error('No sent initial email found — cannot generate a follow-up');
  }

  const previousFollowUp = sentEmails.filter((e) => e.kind !== 'initial').at(-1);
  const totalOpens = sentEmails.reduce((sum, email) => sum + email.openCount, 0);

  // Engagement gate. Someone who has opened nothing after two touches is not
  // seeing these messages — continuing is pure spam signal with no upside, so
  // the sequence closes itself rather than spending reputation on silence.
  if (followUpNumber >= 3 && totalOpens === 0) {
    await db
      .update(leads)
      .set({ status: 'closed', nextFollowUpAt: null, updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    return {
      skipped: true,
      reason: 'No opens after two touches — sequence stopped to protect sender reputation',
    };
  }

  const [existing] = await db
    .select({ id: emails.id })
    .from(emails)
    .where(and(eq(emails.leadId, leadId), eq(emails.status, 'pending_approval')))
    .limit(1);

  if (existing) {
    return { skipped: true, reason: 'A draft is already pending approval', emailId: existing.id };
  }

  const daysSinceFirst = original.sentAt
    ? Math.floor((Date.now() - original.sentAt.getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  try {
    const { data, meta } = await generateFollowUp({
      organizationId,
      leadId,
      companyId: ctx.company.id,
      followUpNumber,
      maxFollowUps,
      daysSinceFirst,
      originalEmail: { subject: original.subject, body: original.bodyText },
      previousFollowUp: previousFollowUp
        ? { subject: previousFollowUp.subject, body: previousFollowUp.bodyText }
        : null,
      contact: {
        fullName: ctx.contact.fullName,
        firstName: ctx.contact.firstName,
        jobTitle: ctx.contact.jobTitle,
      },
      company: { name: ctx.company.name },
      research: {
        summary: ctx.research?.summary ?? 'No research available.',
        opportunities: ctx.research?.opportunities ?? null,
        hooks: normalizeHooks(ctx.research?.personalizationHooks),
      },
      engagement: { openCount: totalOpens },
      organization: {
        senderName: ctx.organization?.senderName ?? null,
        senderTitle: ctx.organization?.senderTitle ?? null,
      },
      // Same guidance as the initial email, so the follow-up stays in the voice
      // of whichever arm this lead belongs to.
      campaignInstructions: buildCampaignInstructions(ctx),
    });

    const [email] = await db
      .insert(emails)
      .values({
        organizationId,
        leadId,
        kind:
          (['follow_up_1', 'follow_up_2', 'follow_up_3'] as const)[followUpNumber - 1] ??
          'follow_up_3',
        status: 'pending_approval',
        subject: data.subject,
        bodyText: data.body,
        originalSubject: data.subject,
        originalBodyText: data.body,
        toAddress: ctx.contact.email,
        // Threading headers keep the follow-up in the original conversation.
        inReplyTo: original.messageIdHeader,
        threadId: original.threadId ?? original.messageIdHeader,
        model: meta.model,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        costUsd: meta.costUsd.toFixed(6),
      })
      .returning({ id: emails.id });

    // followUpCount increments on SEND, not on draft — a rejected draft must not
    // consume one of the two allowed follow-ups.
    await db
      .update(leads)
      .set({ requiresAttention: true, attentionReason: 'Follow-up drafted — needs approval', updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    return { emailId: email!.id, costUsd: meta.costUsd, angle: data.angle };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(leads)
      .set({ lastError: message, updatedAt: new Date() })
      .where(eq(leads.id, leadId));
    throw error;
  }
};
