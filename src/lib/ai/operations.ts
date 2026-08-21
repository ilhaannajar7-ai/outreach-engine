/**
 * The four AI operations.
 *
 * Every one of them follows the same shape:
 *   1. Check the budget BEFORE spending anything.
 *   2. Resolve model + prompt from the database.
 *   3. Call the provider through the AiService interface.
 *   4. Record usage — on success AND on failure.
 *
 * Nothing here writes to leads/emails/replies. The jobs own those transitions;
 * these functions only produce content. That separation is what lets a job be
 * retried without duplicating an AI charge or corrupting lead state.
 */

import { z } from 'zod';
import { getAiService } from '@/lib/providers/ai';
import type { AiOperation } from '@/db/schema';
import { getAiConfig } from './config';
import { renderTemplate } from './prompts';
import { assertWithinBudget, recordAiUsage } from './budget';

// ---------------------------------------------------------------------------
// Output schemas — the model's JSON is validated before it touches the DB.
// ---------------------------------------------------------------------------

/**
 * A hook is an observation plus what it implies.
 *
 * Accepts a bare string as well, because a prompt edited in the dashboard may
 * revert to the older flat format — losing the inference is survivable, a hard
 * validation failure on every research call is not.
 */
const hookSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { observation: value, inference: '' } : value),
  z.object({
    observation: z.string().min(1),
    inference: z.string().default(''),
  }),
);

const researchSchema = z.object({
  summary: z.string().min(1),
  fit_score: z.number().min(0).max(100).default(50),
  fit_reasoning: z.string().default(''),
  disqualifiers: z.array(z.string()).default([]),
  pain_points: z.array(z.string()).default([]),
  opportunities: z.array(z.string()).default([]),
  value_proposition: z.string().default(''),
  hooks: z.array(hookSchema).default([]),
});

const emailSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1),
  personalization_note: z.string().default(''),
  // The model's own judgement on whether the opening passes the specificity
  // test. Advisory only — `hook-quality.ts` is the authority.
  opening_is_specific: z.boolean().default(true),
});

const followUpSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1),
  angle: z.string().default(''),
});

const classificationSchema = z.object({
  classification: z.enum([
    'interested',
    'maybe',
    'not_interested',
    'out_of_office',
    'wrong_person',
    'unsubscribe_request',
    'auto_reply',
    'unclassified',
  ]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().default(''),
  summary: z.string().default(''),
  suggested_action: z.string().default(''),
});

export type ResearchOutput = z.infer<typeof researchSchema>;
export type EmailOutput = z.infer<typeof emailSchema>;
export type FollowUpOutput = z.infer<typeof followUpSchema>;
export type ClassificationOutput = z.infer<typeof classificationSchema>;

export interface AiCallMeta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

/**
 * Shared execution path for all four operations. Centralising the budget check
 * and usage recording here means a new operation cannot accidentally be added
 * without cost controls.
 */
async function execute<T>(params: {
  organizationId: string;
  operation: AiOperation;
  variables: Record<string, string>;
  // Input is `unknown` because the schemas use .default() — the parsed output
  // type is what callers get, and it differs from the accepted input shape.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  leadId?: string | null;
  companyId?: string | null;
  /** Rough pre-call price used only for the budget gate. */
  estimatedCost?: number;
}): Promise<{ data: T; meta: AiCallMeta }> {
  const { organizationId, operation, variables, schema } = params;

  await assertWithinBudget(organizationId, operation, params.estimatedCost ?? 0.02);

  const config = await getAiConfig(organizationId, operation);
  if (!config.isEnabled) {
    throw new Error(`AI operation "${operation}" is disabled in AI Configuration.`);
  }

  const ai = getAiService();
  const userPrompt = renderTemplate(config.userPromptTemplate, variables);

  try {
    const result = await ai.completeJson(
      {
        model: config.model,
        systemPrompt: config.systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        expectJson: true,
      },
      (raw) => schema.parse(raw),
    );

    await recordAiUsage({
      organizationId,
      operation,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      costUsd: result.usage.costUsd,
      leadId: params.leadId ?? null,
      companyId: params.companyId ?? null,
      durationMs: result.durationMs,
      success: true,
    });

    return {
      data: result.data,
      meta: {
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        durationMs: result.durationMs,
      },
    };
  } catch (error) {
    // A failed call was still billed by the provider in most cases. Record it
    // with cost 0 so the failure is visible in the audit trail even though the
    // exact charge is unknown.
    await recordAiUsage({
      organizationId,
      operation,
      model: config.model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      leadId: params.leadId ?? null,
      companyId: params.companyId ?? null,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch(() => {
      // Never let usage bookkeeping mask the original failure.
    });

    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. Research
// ---------------------------------------------------------------------------

export async function researchCompany(params: {
  organizationId: string;
  companyId: string;
  company: {
    name: string;
    domain?: string | null;
    industry?: string | null;
    sizeRange?: string | null;
    location?: string | null;
    description?: string | null;
    hiringSignal?: string | null;
  };
  organization: {
    servicesOffered?: string | null;
    valueProposition?: string | null;
  };
}): Promise<{ data: ResearchOutput; meta: AiCallMeta }> {
  return execute({
    organizationId: params.organizationId,
    operation: 'research',
    companyId: params.companyId,
    schema: researchSchema,
    estimatedCost: 0.005,
    variables: {
      company_name: params.company.name,
      company_domain: params.company.domain ?? 'unknown',
      industry: params.company.industry ?? 'unknown',
      size_range: params.company.sizeRange ?? 'unknown',
      location: params.company.location ?? 'unknown',
      description: params.company.description ?? 'No description available.',
      hiring_signal: params.company.hiringSignal ?? 'No specific hiring signal recorded.',
      our_services: params.organization.servicesOffered ?? 'Outsourcing services.',
      our_value_proposition: params.organization.valueProposition ?? '',
    },
  });
}

// ---------------------------------------------------------------------------
// 2. Initial email
// ---------------------------------------------------------------------------

export async function generateEmail(params: {
  organizationId: string;
  leadId: string;
  companyId: string;
  contact: { fullName?: string | null; firstName?: string | null; jobTitle?: string | null };
  company: { name: string; hiringSignal?: string | null };
  research: {
    summary: string;
    painPoints?: string[] | null;
    opportunities?: string[] | null;
    /** Pre-scored and sorted by the caller; index 0 is the one to build on. */
    hooks?: { observation: string; inference: string }[] | null;
    valueProposition?: string | null;
  };
  organization: {
    servicesOffered?: string | null;
    valueProposition?: string | null;
    senderName?: string | null;
    senderTitle?: string | null;
    calendarLink?: string | null;
  };
  campaignInstructions?: string | null;
}): Promise<{ data: EmailOutput; meta: AiCallMeta }> {
  const contactName =
    params.contact.fullName ?? params.contact.firstName ?? 'there';

  // The strongest hook is handed to the model on its own, under its own
  // heading. Burying it in a list is how it ends up unused and the email opens
  // with a generic line instead.
  const hooks = params.research.hooks ?? [];
  const best = hooks[0];
  const rest = hooks.slice(1);

  return execute({
    organizationId: params.organizationId,
    operation: 'email_generation',
    leadId: params.leadId,
    companyId: params.companyId,
    schema: emailSchema,
    estimatedCost: 0.02,
    variables: {
      contact_name: contactName,
      contact_title: params.contact.jobTitle ?? 'unknown',
      company_name: params.company.name,
      best_hook_observation: best?.observation ?? 'No specific hook was found.',
      best_hook_inference:
        best?.inference ?? 'Nothing could be inferred — keep the opening factual and brief.',
      other_hooks: rest.length
        ? rest.map((h) => `- ${h.observation} → ${h.inference}`).join('\n')
        : 'None.',
      research_summary: params.research.summary,
      research_pain_points: bullets(params.research.painPoints),
      research_opportunities: bullets(params.research.opportunities),
      research_value_prop: params.research.valueProposition ?? '',
      hiring_signal: params.company.hiringSignal ?? 'Not recorded.',
      our_services: params.organization.servicesOffered ?? 'Outsourcing services.',
      our_value_proposition: params.organization.valueProposition ?? '',
      sender_name: params.organization.senderName ?? 'The team',
      sender_title: params.organization.senderTitle ?? '',
      calendar_line: params.organization.calendarLink
        ? `Booking link (use only if a call is the ask): ${params.organization.calendarLink}`
        : '',
      campaign_instructions: params.campaignInstructions
        ? `Additional instructions for this campaign:\n${params.campaignInstructions}`
        : '',
    },
  });
}

// ---------------------------------------------------------------------------
// 3. Follow-up
// ---------------------------------------------------------------------------

export async function generateFollowUp(params: {
  organizationId: string;
  leadId: string;
  companyId: string;
  followUpNumber: number;
  maxFollowUps: number;
  daysSinceFirst: number;
  originalEmail: { subject: string; body: string };
  previousFollowUp?: { subject: string; body: string } | null;
  contact: { fullName?: string | null; firstName?: string | null; jobTitle?: string | null };
  company: { name: string };
  research: {
    summary: string;
    opportunities?: string[] | null;
    hooks?: { observation: string; inference: string }[] | null;
  };
  /** Drives tone: someone who has opened twice is warmer than total silence. */
  engagement?: { openCount: number } | null;
  organization: { senderName?: string | null; senderTitle?: string | null };
}): Promise<{ data: FollowUpOutput; meta: AiCallMeta }> {
  const isFinal = params.followUpNumber >= params.maxFollowUps;
  const openCount = params.engagement?.openCount ?? 0;

  return execute({
    organizationId: params.organizationId,
    operation: 'follow_up_generation',
    leadId: params.leadId,
    companyId: params.companyId,
    schema: followUpSchema,
    estimatedCost: 0.005,
    variables: {
      follow_up_number: String(params.followUpNumber),
      max_follow_ups: String(params.maxFollowUps),
      days_since_first: String(params.daysSinceFirst),
      original_subject: params.originalEmail.subject,
      original_body: params.originalEmail.body,
      previous_follow_up_block: params.previousFollowUp
        ? `Previous follow-up already sent:\n  Subject: ${params.previousFollowUp.subject}\n  Body:\n${params.previousFollowUp.body}`
        : 'No previous follow-up has been sent.',
      contact_name: params.contact.fullName ?? params.contact.firstName ?? 'there',
      contact_title: params.contact.jobTitle ?? 'unknown',
      company_name: params.company.name,
      final_follow_up_note: isFinal
        ? 'THIS IS THE FINAL MESSAGE. Give them a clean, graceful exit and do not ask again.'
        : '',
      engagement_summary:
        openCount > 1
          ? `They have opened the thread ${openCount} times but not replied — mild interest, or a busy inbox. Keep it warm and make the ask smaller.`
          : openCount === 1
            ? 'They opened once and did not reply. Assume busy, not uninterested.'
            : 'No opens recorded. Keep it very short — a long message will not be read either.',
      research_summary: params.research.summary,
      research_opportunities: bullets(params.research.opportunities),
      research_hooks: params.research.hooks?.length
        ? params.research.hooks.map((h) => `- ${h.observation} → ${h.inference}`).join('\n')
        : 'None recorded.',
      sender_name: params.organization.senderName ?? 'The team',
      sender_title: params.organization.senderTitle ?? '',
    },
  });
}

// ---------------------------------------------------------------------------
// 4. Reply classification
// ---------------------------------------------------------------------------

export async function classifyReply(params: {
  organizationId: string;
  leadId: string;
  sentEmail: { subject: string; body: string };
  reply: { from: string; subject?: string | null; body: string };
}): Promise<{ data: ClassificationOutput; meta: AiCallMeta }> {
  return execute({
    organizationId: params.organizationId,
    operation: 'reply_classification',
    leadId: params.leadId,
    schema: classificationSchema,
    estimatedCost: 0.002,
    variables: {
      sent_subject: params.sentEmail.subject,
      sent_body: params.sentEmail.body,
      reply_from: params.reply.from,
      reply_subject: params.reply.subject ?? '(no subject)',
      // Long threads are mostly quoted history; the first 4000 chars carry the
      // actual reply and keep the input token cost predictable.
      reply_body: params.reply.body.slice(0, 4000),
    },
  });
}

function bullets(items?: string[] | null): string {
  if (!items?.length) return 'None recorded.';
  return items.map((i) => `- ${i}`).join('\n');
}
