/**
 * Tools the dashboard assistant can call.
 *
 * Every tool declares an `access` level, and that level is enforced by the
 * loop, not by the model:
 *
 *   read  — runs immediately. Cannot change anything.
 *   write — never executed by the model. The loop stops, returns the exact
 *           tool name and arguments to the UI, and the operator confirms the
 *           real parameters before anything runs.
 *
 * Three things are deliberately absent and must stay absent: sending or
 * approving email, raising the AI spend cap, and deleting records. Approval is
 * the system's core safety property — an assistant that could send on the
 * operator's behalf would remove the only thing standing between a bad
 * afternoon and a burned domain.
 */

import { db } from '@/db';
import {
  leads,
  companies,
  contacts,
  emails,
  campaigns,
  sendingDomains,
  sendingInboxes,
  systemHealth,
  backgroundJobs,
  aiModelConfig,
  settings,
  aiResearch,
} from '@/db/schema';
import { and, eq, desc, sql as dsql, inArray } from 'drizzle-orm';
import { getBudgetStatus, getUsageByOperation } from '@/lib/ai/budget';
import { getRemainingCapacityToday, warmupDailyLimit } from '@/lib/sending/inbox-rotation';
import { normalizeHooks } from '@/lib/ai/hook-quality';
import type { AiToolDefinition } from '@/lib/providers/ai';

export type ToolAccess = 'read' | 'write';

export interface AssistantContext {
  organizationId: string;
  userId: string;
  /** Viewers may read but never propose a change. */
  canWrite: boolean;
}

export interface AssistantTool {
  name: string;
  description: string;
  access: ToolAccess;
  inputSchema: Record<string, unknown>;
  /**
   * One line describing the pending change, shown on the confirmation card.
   * Write tools must provide it — it is what the operator actually approves.
   */
  summarize?: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>, ctx: AssistantContext) => Promise<unknown>;
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const getStatus: AssistantTool = {
  name: 'get_status',
  access: 'read',
  description:
    'Overall system status: lead counts by stage, drafts awaiting approval, sending capacity ' +
    'left today, AI budget used, and how many leads need human attention. Call this for any ' +
    'general "how are things going" question.',
  inputSchema: EMPTY_SCHEMA,
  run: async (_input, ctx) => {
    const [leadStats, emailStats, budget, capacity] = await Promise.all([
      db
        .select({
          total: dsql<number>`COUNT(*)::int`,
          needsResearch: dsql<number>`COUNT(*) FILTER (WHERE ${leads.status} = 'new')::int`,
          ready: dsql<number>`COUNT(*) FILTER (WHERE ${leads.status} = 'ready_to_contact')::int`,
          contacted: dsql<number>`COUNT(*) FILTER (WHERE ${leads.firstContactedAt} IS NOT NULL)::int`,
          replied: dsql<number>`COUNT(*) FILTER (WHERE ${leads.repliedAt} IS NOT NULL)::int`,
          interested: dsql<number>`COUNT(*) FILTER (WHERE ${leads.status} = 'interested')::int`,
          needsAttention: dsql<number>`COUNT(*) FILTER (WHERE ${leads.requiresAttention} = true)::int`,
        })
        .from(leads)
        .where(eq(leads.organizationId, ctx.organizationId)),
      db
        .select({
          pendingApproval: dsql<number>`COUNT(*) FILTER (WHERE ${emails.status} = 'pending_approval')::int`,
          queued: dsql<number>`COUNT(*) FILTER (WHERE ${emails.status} = 'queued')::int`,
        })
        .from(emails)
        .where(eq(emails.organizationId, ctx.organizationId)),
      getBudgetStatus(ctx.organizationId),
      getRemainingCapacityToday(ctx.organizationId),
    ]);

    const l = leadStats[0];
    const replyRate =
      l && l.contacted > 0 ? `${((l.replied / l.contacted) * 100).toFixed(1)}%` : 'n/a';

    return {
      leads: { ...l, replyRate },
      drafts: emailStats[0],
      sendingToday: {
        sent: capacity.sentToday,
        remaining: capacity.remaining,
        cap: capacity.globalLimit,
        activeInboxes: capacity.inboxCount,
      },
      aiBudget: {
        spentUsd: Number(budget.spent.toFixed(2)),
        warnAtUsd: budget.warnAt,
        stopAtUsd: budget.stopAt,
        percentUsed: Math.round((budget.spent / budget.stopAt) * 100),
        isExceeded: budget.isExceeded,
      },
    };
  },
};

const listLeads: AssistantTool = {
  name: 'list_leads',
  access: 'read',
  description:
    'List leads, optionally filtered by status. Use when asked about specific leads, who needs ' +
    'attention, or which companies are at a given stage.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description:
          'Filter by lead status, e.g. new, researched, ready_to_contact, contacted, interested, error.',
      },
      needsAttentionOnly: {
        type: 'boolean',
        description: 'Only return leads flagged as requiring human attention.',
      },
      limit: { type: 'integer', description: 'Max rows, default 20, cap 50.' },
    },
    additionalProperties: false,
  },
  run: async (input, ctx) => {
    const limit = Math.min(Number(input.limit ?? 20), 50);
    const where = [eq(leads.organizationId, ctx.organizationId)];

    if (typeof input.status === 'string') {
      where.push(dsql`${leads.status} = ${input.status}`);
    }
    if (input.needsAttentionOnly === true) {
      where.push(eq(leads.requiresAttention, true));
    }

    const rows = await db
      .select({
        company: companies.name,
        contact: contacts.fullName,
        title: contacts.jobTitle,
        status: leads.status,
        signal: companies.hiringSignal,
        attentionReason: leads.attentionReason,
        followUps: leads.followUpCount,
      })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(and(...where))
      .orderBy(desc(leads.priority), desc(leads.updatedAt))
      .limit(limit);

    return { count: rows.length, leads: rows };
  },
};

const getSendingHealth: AssistantTool = {
  name: 'get_sending_health',
  access: 'read',
  description:
    'Sending infrastructure: domains with SPF/DKIM/DMARC status, inboxes with warm-up progress, ' +
    'reputation scores, and how much of today\'s allowance each has used. Use for deliverability ' +
    'and warm-up questions.',
  inputSchema: EMPTY_SCHEMA,
  run: async (_input, ctx) => {
    const domains = await db
      .select()
      .from(sendingDomains)
      .where(eq(sendingDomains.organizationId, ctx.organizationId));

    const inboxes = await db
      .select({
        email: sendingInboxes.emailAddress,
        domainId: sendingInboxes.domainId,
        status: sendingInboxes.status,
        sentToday: sendingInboxes.sentToday,
        dailyLimit: sendingInboxes.dailySendLimit,
        maxLimit: sendingInboxes.maxDailySendLimit,
        reputation: sendingInboxes.reputationScore,
        totalSent: sendingInboxes.totalSent,
        totalBounced: sendingInboxes.totalBounced,
        totalComplaints: sendingInboxes.totalComplaints,
        warmupStartedAt: sendingInboxes.warmupStartedAt,
        warmupCompleted: sendingInboxes.warmupCompleted,
      })
      .from(sendingInboxes)
      .where(eq(sendingInboxes.organizationId, ctx.organizationId));

    return {
      domains: domains.map((d) => ({
        domain: d.domain,
        status: d.status,
        spf: d.spfStatus,
        dkim: d.dkimStatus,
        dmarc: d.dmarcStatus,
        dnsLastCheckedAt: d.dnsLastCheckedAt,
      })),
      inboxes: inboxes.map((i) => {
        const complaintRate =
          i.totalSent > 0 ? (i.totalComplaints / i.totalSent) * 100 : 0;
        const bounceRate = i.totalSent > 0 ? (i.totalBounced / i.totalSent) * 100 : 0;

        return {
          email: i.email,
          domain: domains.find((d) => d.id === i.domainId)?.domain,
          status: i.status,
          sentToday: i.sentToday,
          todayCap: i.warmupCompleted
            ? i.maxLimit
            : warmupDailyLimit(i.warmupStartedAt, i.maxLimit, i.warmupCompleted),
          finalCap: i.maxLimit,
          reputationScore: i.reputation,
          bounceRatePercent: Number(bounceRate.toFixed(2)),
          // Google filters a domain past 0.3%; surfacing it makes the number
          // actionable instead of abstract.
          complaintRatePercent: Number(complaintRate.toFixed(3)),
          complaintThresholdPercent: 0.3,
          warmupCompleted: i.warmupCompleted,
        };
      }),
    };
  },
};

const getAiSetup: AssistantTool = {
  name: 'get_ai_setup',
  access: 'read',
  description:
    'Current AI configuration: which model runs each operation, and month-to-date spend broken ' +
    'down by operation. Use for cost questions and before proposing a model change.',
  inputSchema: EMPTY_SCHEMA,
  run: async (_input, ctx) => {
    const [config, budget, byOperation] = await Promise.all([
      db
        .select({
          operation: aiModelConfig.operation,
          model: aiModelConfig.model,
          isEnabled: aiModelConfig.isEnabled,
        })
        .from(aiModelConfig)
        .where(eq(aiModelConfig.organizationId, ctx.organizationId)),
      getBudgetStatus(ctx.organizationId),
      getUsageByOperation(ctx.organizationId),
    ]);

    return {
      models: config,
      budget: {
        spentUsd: Number(budget.spent.toFixed(2)),
        warnAtUsd: budget.warnAt,
        stopAtUsd: budget.stopAt,
        isExceeded: budget.isExceeded,
      },
      spendByOperation: byOperation,
    };
  },
};

const getProblems: AssistantTool = {
  name: 'get_problems',
  access: 'read',
  description:
    'Everything currently wrong: failed background jobs with their errors, unhealthy system ' +
    'components, paused or blocked inboxes, and domains failing DNS. Call this for "what is ' +
    'broken" or when diagnosing.',
  inputSchema: EMPTY_SCHEMA,
  run: async (_input, ctx) => {
    const [deadJobs, health, badInboxes, badDomains] = await Promise.all([
      db
        .select({
          type: backgroundJobs.type,
          attempts: backgroundJobs.attempts,
          error: backgroundJobs.lastError,
          failedAt: backgroundJobs.completedAt,
        })
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.organizationId, ctx.organizationId),
            inArray(backgroundJobs.status, ['dead', 'failed']),
          ),
        )
        .orderBy(desc(backgroundJobs.updatedAt))
        .limit(15),
      db
        .select()
        .from(systemHealth)
        .where(dsql`${systemHealth.status} <> 'operational'`),
      db
        .select({
          email: sendingInboxes.emailAddress,
          status: sendingInboxes.status,
          reputation: sendingInboxes.reputationScore,
        })
        .from(sendingInboxes)
        .where(
          and(
            eq(sendingInboxes.organizationId, ctx.organizationId),
            inArray(sendingInboxes.status, ['paused', 'blocked']),
          ),
        ),
      db
        .select({
          domain: sendingDomains.domain,
          spf: sendingDomains.spfStatus,
          dkim: sendingDomains.dkimStatus,
          dmarc: sendingDomains.dmarcStatus,
        })
        .from(sendingDomains)
        .where(
          and(
            eq(sendingDomains.organizationId, ctx.organizationId),
            dsql`(${sendingDomains.spfStatus} <> 'pass' OR ${sendingDomains.dkimStatus} <> 'pass' OR ${sendingDomains.dmarcStatus} <> 'pass')`,
          ),
        ),
    ]);

    return {
      failedJobs: deadJobs,
      unhealthyComponents: health.map((h) => ({
        component: h.component,
        status: h.status,
        message: h.message,
        consecutiveFailures: h.consecutiveFailures,
      })),
      pausedInboxes: badInboxes,
      domainsFailingDns: badDomains,
      allClear:
        deadJobs.length === 0 &&
        health.length === 0 &&
        badInboxes.length === 0 &&
        badDomains.length === 0,
    };
  },
};

const inspectLead: AssistantTool = {
  name: 'inspect_lead',
  access: 'read',
  description:
    'Full detail for one lead found by company name: contact, research brief with scored hooks, ' +
    'every email sent, and any replies. Use when asked about a specific company.',
  inputSchema: {
    type: 'object',
    properties: {
      companyName: {
        type: 'string',
        description: 'Company name or part of it. Matched case-insensitively.',
      },
    },
    required: ['companyName'],
    additionalProperties: false,
  },
  run: async (input, ctx) => {
    const search = String(input.companyName ?? '').trim();
    if (!search) return { error: 'companyName is required.' };

    const [row] = await db
      .select({
        leadId: leads.id,
        company: companies.name,
        companyId: companies.id,
        industry: companies.industry,
        size: companies.sizeRange,
        signal: companies.hiringSignal,
        contact: contacts.fullName,
        title: contacts.jobTitle,
        emailVerified: contacts.emailVerified,
        status: leads.status,
        followUps: leads.followUpCount,
        attentionReason: leads.attentionReason,
      })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(
        and(
          eq(leads.organizationId, ctx.organizationId),
          dsql`${companies.name} ILIKE ${'%' + search + '%'}`,
        ),
      )
      .limit(1);

    if (!row) return { found: false, message: `No lead found matching "${search}".` };

    const [research] = await db
      .select()
      .from(aiResearch)
      .where(and(eq(aiResearch.companyId, row.companyId), eq(aiResearch.isStale, false)))
      .limit(1);

    const emailRows = await db
      .select({
        kind: emails.kind,
        status: emails.status,
        subject: emails.subject,
        sentAt: emails.sentAt,
        opens: emails.openCount,
      })
      .from(emails)
      .where(eq(emails.leadId, row.leadId))
      .orderBy(emails.createdAt);

    return {
      found: true,
      lead: row,
      research: research
        ? {
            summary: research.summary,
            fitScore: research.fitScore,
            hookQualityScore: research.hookQualityScore,
            hooks: normalizeHooks(research.personalizationHooks),
            disqualifiers: research.disqualifiers,
          }
        : null,
      emails: emailRows,
    };
  },
};

// ---------------------------------------------------------------------------
// Write tools — proposed, never executed without confirmation
// ---------------------------------------------------------------------------

const VALID_OPERATIONS = [
  'research',
  'email_generation',
  'follow_up_generation',
  'reply_classification',
  'assistant',
] as const;

const setAiModel: AssistantTool = {
  name: 'set_ai_model',
  access: 'write',
  description:
    'Change which Claude model runs one AI operation. Takes effect on the next call, no restart. ' +
    'Cheaper models: claude-haiku-4-5. Higher quality: claude-sonnet-5, claude-opus-5.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...VALID_OPERATIONS],
        description: 'Which operation to change.',
      },
      model: {
        type: 'string',
        description: 'Model id, e.g. claude-haiku-4-5, claude-sonnet-5, claude-opus-5.',
      },
    },
    required: ['operation', 'model'],
    additionalProperties: false,
  },
  summarize: (input) =>
    `Switch ${String(input.operation).replace(/_/g, ' ')} to ${String(input.model)}`,
  run: async (input, ctx) => {
    const operation = String(input.operation);
    const model = String(input.model);

    if (!VALID_OPERATIONS.includes(operation as (typeof VALID_OPERATIONS)[number])) {
      return { error: `Unknown operation "${operation}".` };
    }

    await db
      .update(aiModelConfig)
      .set({ model, updatedBy: ctx.userId, updatedAt: new Date() })
      .where(
        and(
          eq(aiModelConfig.organizationId, ctx.organizationId),
          dsql`${aiModelConfig.operation} = ${operation}`,
        ),
      );

    return { changed: true, operation, model };
  },
};

const setBudget: AssistantTool = {
  name: 'set_ai_budget',
  access: 'write',
  description:
    'Change the monthly AI spend thresholds. The warn threshold sends a notification; the stop ' +
    'threshold refuses all further AI calls. Both are in USD.',
  inputSchema: {
    type: 'object',
    properties: {
      warnAtUsd: { type: 'number', description: 'Notify at this monthly spend.' },
      stopAtUsd: { type: 'number', description: 'Refuse all AI calls at this monthly spend.' },
    },
    additionalProperties: false,
  },
  summarize: (input) => {
    const parts: string[] = [];
    if (input.warnAtUsd !== undefined) parts.push(`warn at $${Number(input.warnAtUsd).toFixed(2)}`);
    if (input.stopAtUsd !== undefined) parts.push(`stop at $${Number(input.stopAtUsd).toFixed(2)}`);
    return `Set AI budget: ${parts.join(', ')}`;
  },
  run: async (input, ctx) => {
    const writes: { key: string; value: number }[] = [];
    if (input.warnAtUsd !== undefined)
      writes.push({ key: 'ai_budget_warn', value: Number(input.warnAtUsd) });
    if (input.stopAtUsd !== undefined)
      writes.push({ key: 'ai_budget_stop', value: Number(input.stopAtUsd) });

    if (writes.length === 0) return { error: 'Nothing to change.' };

    for (const write of writes) {
      if (!Number.isFinite(write.value) || write.value <= 0) {
        return { error: `${write.key} must be a positive number.` };
      }
      await db
        .insert(settings)
        .values({
          organizationId: ctx.organizationId,
          key: write.key,
          value: write.value,
          valueType: 'number',
          updatedBy: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [settings.organizationId, settings.key],
          set: { value: write.value, updatedBy: ctx.userId, updatedAt: new Date() },
        });
    }

    return { changed: true, applied: writes };
  },
};

const retryFailedJobs: AssistantTool = {
  name: 'retry_failed_jobs',
  access: 'write',
  description:
    'Re-queue background jobs that died, so the worker attempts them again. Use after the cause ' +
    'has been fixed (a corrected key, a raised budget, a provider outage that has ended).',
  inputSchema: {
    type: 'object',
    properties: {
      jobType: {
        type: 'string',
        description: 'Optional: only retry this job type, e.g. research_company.',
      },
    },
    additionalProperties: false,
  },
  summarize: (input) =>
    input.jobType
      ? `Re-queue all dead "${String(input.jobType)}" jobs`
      : 'Re-queue every dead background job',
  run: async (input, ctx) => {
    const where = [
      eq(backgroundJobs.organizationId, ctx.organizationId),
      inArray(backgroundJobs.status, ['dead', 'failed'] as const),
    ];
    if (typeof input.jobType === 'string') {
      where.push(dsql`${backgroundJobs.type} = ${input.jobType}`);
    }

    const requeued = await db
      .update(backgroundJobs)
      .set({
        status: 'pending',
        attempts: 0,
        runAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        startedAt: null,
        completedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(...where))
      .returning({ id: backgroundJobs.id });

    return { requeued: requeued.length };
  },
};

const setCampaignStatus: AssistantTool = {
  name: 'set_campaign_status',
  access: 'write',
  description:
    'Activate, pause, or archive a campaign by name. Pausing also clears scheduled follow-ups ' +
    'for its leads, so no new drafts appear.',
  inputSchema: {
    type: 'object',
    properties: {
      campaignName: { type: 'string', description: 'Campaign name or part of it.' },
      status: { type: 'string', enum: ['active', 'paused', 'archived'] },
    },
    required: ['campaignName', 'status'],
    additionalProperties: false,
  },
  summarize: (input) => `Set campaign "${String(input.campaignName)}" to ${String(input.status)}`,
  run: async (input, ctx) => {
    const search = String(input.campaignName ?? '').trim();
    const status = String(input.status) as 'active' | 'paused' | 'archived';

    const [campaign] = await db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.organizationId, ctx.organizationId),
          dsql`${campaigns.name} ILIKE ${'%' + search + '%'}`,
        ),
      )
      .limit(1);

    if (!campaign) return { error: `No campaign matching "${search}".` };

    await db
      .update(campaigns)
      .set({ status, updatedAt: new Date() })
      .where(eq(campaigns.id, campaign.id));

    if (status === 'paused' || status === 'archived') {
      await db
        .update(leads)
        .set({ nextFollowUpAt: null, updatedAt: new Date() })
        .where(eq(leads.campaignId, campaign.id));
    }

    return { changed: true, campaign: campaign.name, status };
  },
};

const queueResearch: AssistantTool = {
  name: 'queue_research',
  access: 'write',
  description:
    'Queue AI research for leads that have not been researched yet. This spends AI budget — ' +
    'roughly $0.003 per company. Research is cached per company.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'How many unresearched leads to queue. Default 10, cap 50.',
      },
    },
    additionalProperties: false,
  },
  summarize: (input) =>
    `Queue AI research for up to ${Math.min(Number(input.limit ?? 10), 50)} unresearched leads ` +
    `(~$${(Math.min(Number(input.limit ?? 10), 50) * 0.003).toFixed(2)})`,
  run: async (input, ctx) => {
    const limit = Math.min(Number(input.limit ?? 10), 50);

    const targets = await db
      .select({ leadId: leads.id, companyId: leads.companyId, company: companies.name })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .where(and(eq(leads.organizationId, ctx.organizationId), eq(leads.status, 'new')))
      .limit(limit);

    if (targets.length === 0) return { queued: 0, message: 'No unresearched leads found.' };

    const { getJobQueue } = await import('@/lib/providers/queue');
    const queue = getJobQueue();

    for (const target of targets) {
      await queue.enqueue(
        'research_company',
        { companyId: target.companyId, leadId: target.leadId },
        {
          organizationId: ctx.organizationId,
          // One research job per company, however many contacts it has.
          idempotencyKey: `research:${target.companyId}`,
        },
      );
    }

    return { queued: targets.length, companies: targets.map((t) => t.company) };
  },
};

const recheckDns: AssistantTool = {
  name: 'recheck_dns',
  access: 'write',
  description:
    'Re-run the live SPF/DKIM/DMARC lookup for a sending domain. Use after DNS records have been ' +
    'added or changed at the registrar.',
  inputSchema: {
    type: 'object',
    properties: { domain: { type: 'string', description: 'The sending domain to re-check.' } },
    required: ['domain'],
    additionalProperties: false,
  },
  summarize: (input) => `Re-check DNS records for ${String(input.domain)}`,
  run: async (input, ctx) => {
    const search = String(input.domain ?? '').trim();

    const [domain] = await db
      .select()
      .from(sendingDomains)
      .where(
        and(
          eq(sendingDomains.organizationId, ctx.organizationId),
          dsql`${sendingDomains.domain} ILIKE ${'%' + search + '%'}`,
        ),
      )
      .limit(1);

    if (!domain) return { error: `No sending domain matching "${search}".` };

    const { checkAllDns } = await import('@/lib/sending/dns-check');
    // No selector argument — the checker probes the common Google/Resend
    // selectors, which is what every domain here uses.
    const result = await checkAllDns(domain.domain);

    await db
      .update(sendingDomains)
      .set({
        spfStatus: result.spf.status,
        dkimStatus: result.dkim.status,
        dmarcStatus: result.dmarc.status,
        dnsLastCheckedAt: new Date(),
        // Promote out of pending_dns once everything resolves, matching what
        // the Domains page does — warm-up cannot start until DNS passes.
        ...(result.allPassing && domain.status === 'pending_dns'
          ? { status: 'warming' as const, warmupStartedAt: new Date() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(sendingDomains.id, domain.id));

    return {
      domain: domain.domain,
      spf: result.spf,
      dkim: result.dkim,
      dmarc: result.dmarc,
      mx: result.mx,
      allPassing: result.allPassing,
    };
  },
};

const discoverContacts: AssistantTool = {
  name: 'discover_contacts',
  access: 'write',
  description:
    'Queue contact discovery for companies that have a domain but no contact yet. Finds the ' +
    'decision-maker via the enrichment provider and verifies the address. Spends one search plus ' +
    'one verification credit per company.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many companies to enrich. Default 25, cap 200.' },
      thenResearch: {
        type: 'boolean',
        description: 'Also queue AI research once each contact verifies. Spends AI budget.',
      },
    },
    additionalProperties: false,
  },
  summarize: (input) =>
    `Find & verify contacts for up to ${Math.min(Number(input.limit ?? 25), 200)} companies` +
    (input.thenResearch ? ', then research each' : ''),
  run: async (input, ctx) => {
    const limit = Math.min(Number(input.limit ?? 25), 200);

    const targets = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .leftJoin(contacts, eq(contacts.companyId, companies.id))
      .where(
        and(
          eq(companies.organizationId, ctx.organizationId),
          dsql`${companies.domain} IS NOT NULL`,
          dsql`${contacts.id} IS NULL`,
        ),
      )
      .groupBy(companies.id, companies.name)
      .limit(limit);

    if (targets.length === 0) {
      return { queued: 0, message: 'Every company with a domain already has a contact.' };
    }

    const { getJobQueue } = await import('@/lib/providers/queue');
    const queue = getJobQueue();
    for (const company of targets) {
      await queue.enqueue(
        'find_contacts',
        { companyId: company.id, thenResearch: input.thenResearch === true },
        { organizationId: ctx.organizationId, idempotencyKey: `find:${company.id}` },
      );
    }

    return { queued: targets.length, companies: targets.map((t) => t.name) };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ASSISTANT_TOOLS: AssistantTool[] = [
  getStatus,
  listLeads,
  getSendingHealth,
  getAiSetup,
  getProblems,
  inspectLead,
  setAiModel,
  setBudget,
  retryFailedJobs,
  setCampaignStatus,
  queueResearch,
  discoverContacts,
  recheckDns,
];

export function getTool(name: string): AssistantTool | undefined {
  return ASSISTANT_TOOLS.find((tool) => tool.name === name);
}

/**
 * Tool definitions for the model.
 *
 * A viewer is offered read tools only — the model cannot propose a change it
 * would not be allowed to make, so it never promises one.
 */
export function toolDefinitions(canWrite: boolean): AiToolDefinition[] {
  return ASSISTANT_TOOLS.filter((tool) => canWrite || tool.access === 'read').map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}
