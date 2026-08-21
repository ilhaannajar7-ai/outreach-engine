/**
 * Sample data for local development.
 *
 * Populates companies, contacts, leads, a campaign, sending infrastructure,
 * emails at various stages, replies, and notifications — enough that every
 * page renders with something real rather than an empty state.
 *
 * Development only. Never run against production.
 */

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

const COMPANIES = [
  ['Northwind Logistics', 'northwind-logistics.com', 'Logistics', '51-200', 'Manchester, UK', 'Hiring 3 accounts receivable clerks and a finance assistant'],
  ['Peak Freight Co', 'peakfreight.co', 'Logistics', '11-50', 'Leeds, UK', 'Posted for an Operations Coordinator and 2 back-office admins'],
  ['Bluegrass Manufacturing', 'bluegrass-mfg.com', 'Manufacturing', '201-500', 'Birmingham, UK', 'Recruiting a payroll specialist and 4 data entry staff'],
  ['Vertex Foods', 'vertexfoods.co.uk', 'Food & Beverage', '51-200', 'Bristol, UK', 'Hiring an AP clerk, second posting this quarter'],
  ['Cedar & Co Advisory', 'cedarandco.com', 'Professional Services', '11-50', 'London, UK', 'Looking for 2 bookkeepers and an admin assistant'],
  ['Harbour Point Retail', 'harbourpoint.co.uk', 'Retail', '201-500', 'Glasgow, UK', 'Hiring 5 customer support agents'],
  ['Ironvale Engineering', 'ironvale.com', 'Manufacturing', '51-200', 'Sheffield, UK', 'Recruiting a finance administrator'],
  ['Sable Health Group', 'sablehealth.co.uk', 'Healthcare Admin', '201-500', 'Nottingham, UK', 'Hiring 4 medical billing coordinators'],
  ['Ridgeway Transport', 'ridgewaytransport.com', 'Logistics', '11-50', 'Cardiff, UK', 'Posted for an accounts assistant'],
  ['Copperline Trading', 'copperline.co', 'Wholesale', '51-200', 'Liverpool, UK', 'Hiring 2 invoice processors'],
];

const CONTACTS = [
  ['James', 'Alvarez', 'Chief Financial Officer', 'Finance', 'executive'],
  ['Maya', 'Osei', 'Operations Lead', 'Operations', 'manager'],
  ['Sarah', 'Tan', 'Managing Director', 'Executive', 'executive'],
  ['Rajvir', 'Kaur', 'Head of Finance', 'Finance', 'director'],
  ['Daniel', 'Park', 'General Manager', 'Operations', 'manager'],
  ['Nadia', 'Rahman', 'Finance Manager', 'Finance', 'manager'],
  ['Tom', 'Whitfield', 'Operations Director', 'Operations', 'director'],
  ['Priya', 'Sharma', 'Head of Administration', 'Admin', 'director'],
  ['Owen', 'Baptiste', 'Financial Controller', 'Finance', 'manager'],
  ['Clara', 'Mendez', 'Chief Operating Officer', 'Executive', 'executive'],
];

const RESEARCH = {
  summary:
    'A regional logistics operator running its finance function in-house. The current hiring push covers accounts receivable and general finance support, which typically signals invoice volume outpacing the existing team rather than a planned expansion.',
  painPoints: [
    'Invoice processing volume has outgrown the current finance headcount',
    'Recruiting four finance staff at once takes months to become productive',
    'Back-office cost scales linearly with shipment volume',
  ],
  opportunities: [
    'Offload accounts receivable and invoice processing to a trained offshore team',
    'Cover finance admin without adding local headcount',
    'Scale capacity up or down with shipment seasonality',
  ],
  // Observation + inference pairs — the shape research produces now. Scores
  // match what hook-quality.ts assigns these exact strings.
  hooks: [
    {
      observation:
        'Posted three accounts receivable clerk roles and a finance assistant in the last 30 days',
      inference:
        'Invoice volume has outgrown the finance team rather than this being planned expansion',
      score: 95,
    },
    {
      observation: 'Has advertised for AR clerks twice since March',
      inference: 'The first hire either fell through or was not enough for the workload',
      score: 87,
    },
  ],
  disqualifiers: [],
  valueProp:
    'A trained offshore finance team covering AR and invoice processing, live in weeks rather than the months a four-person local hire would take.',
};

const EMAIL_BODIES = [
  {
    subject: 'quick question on your AR hiring',
    body: `Hi {first},

Saw you're bringing on three AR clerks plus a finance assistant. That's usually the point where invoice volume has outgrown the current team rather than a headcount plan — and hiring four people is a slow fix for a problem that's already here.

We run AR and invoice processing for logistics firms with the same shape of problem. Teams are trained on your process, not generic.

Worth a 15-minute call to see if the numbers work?

Ilhaan Najar
Director`,
  },
  {
    subject: 'your back-office postings',
    body: `Hi {first},

Noticed the Operations Coordinator and two back-office admin roles. Filling three at once is a long runway before anyone is productive.

We handle back-office operations for firms your size — the team is trained on your process and covers the work while you decide whether the local hires are still needed.

Would a short call be useful?

Ilhaan Najar
Director`,
  },
  {
    subject: 'payroll + data entry roles',
    body: `Hi {first},

You're recruiting a payroll specialist and four data entry staff. That's a meaningful fixed cost to take on for work that's largely process-driven.

We run exactly this for manufacturers — payroll processing and data entry handled by a trained offshore team, scaled to your volume.

Happy to walk through how it works if that's useful.

Ilhaan Najar
Director`,
  },
];

const REPLIES = [
  {
    classification: 'interested',
    confidence: '0.920',
    body: 'Hi Ilhaan,\n\nThis is timely — we have been debating whether to hire all four. Can you send over how the AR piece works and what the ramp-up looks like? Happy to do a call Thursday or Friday.\n\nJames',
    summary: 'Actively considering the offer and asking for details plus a call this week.',
    reasoning: 'Explicitly asks for information and proposes specific call times.',
  },
  {
    classification: 'maybe',
    confidence: '0.780',
    body: 'Thanks for reaching out. Not something we are looking at right now, but ask me again in Q4 when we review the budget.',
    summary: 'Deferred to Q4 budget review — not a no.',
    reasoning: 'Soft positive with a specific future timeframe.',
  },
  {
    classification: 'not_interested',
    confidence: '0.950',
    body: 'We already work with a BPO provider and are happy with them. Please remove me from your list.',
    summary: 'Has an existing provider and asked to be removed.',
    reasoning: 'Clear rejection plus an explicit removal request.',
  },
];

async function main() {
  console.log('Seeding demo data…');

  const [org] = await sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`;
  if (!org) {
    console.error('No organization found. Run `npm run db:seed` first.');
    process.exit(1);
  }
  const orgId = org.id;

  const [user] = await sql`SELECT id FROM users ORDER BY created_at LIMIT 1`;
  const userId = user?.id ?? null;

  // Re-runnable: clear the previous demo rows so repeated runs don't stack up.
  // Order matters — children before parents, since FKs are RESTRICT by default
  // on some of these paths. Organizations, users, prompts, and settings survive.
  await sql`DELETE FROM ai_usage WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM audit_logs WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM notifications WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM background_jobs WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM replies WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM email_events WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM emails WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM leads WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM ai_research WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM contacts WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM companies WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM campaigns WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM sending_inboxes WHERE organization_id = ${orgId}`;
  await sql`DELETE FROM sending_domains WHERE organization_id = ${orgId}`;

  // ── Sending infrastructure ───────────────────────────────────────────
  const [domain1] = await sql`
    INSERT INTO sending_domains (organization_id, domain, status, spf_status, dkim_status,
      dmarc_status, dns_last_checked_at, warmup_started_at, warmup_duration_days,
      warmup_completed, daily_send_limit, max_daily_send_limit)
    VALUES (${orgId}, 'yoursolutions.io', 'active', 'pass', 'pass', 'pass', NOW(),
      NOW() - INTERVAL '28 days', 42, false, 200, 200)
    ON CONFLICT (organization_id, domain) DO UPDATE SET status = 'active'
    RETURNING id`;

  const [domain2] = await sql`
    INSERT INTO sending_domains (organization_id, domain, status, spf_status, dkim_status,
      dmarc_status, dns_last_checked_at, warmup_started_at, warmup_duration_days,
      warmup_completed, daily_send_limit, max_daily_send_limit)
    VALUES (${orgId}, 'yoursolutions.co', 'warming', 'pass', 'pass', 'missing', NOW(),
      NOW() - INTERVAL '13 days', 42, false, 60, 200)
    ON CONFLICT (organization_id, domain) DO UPDATE SET status = 'warming'
    RETURNING id`;

  const inboxes = [
    [domain1.id, 'outreach@yoursolutions.io', 'Ilhaan Najar', 'active', 74, 100, 92, 1840, 21, 1, true],
    [domain1.id, 'team@yoursolutions.io', 'Acme Outsourcing Team', 'active', 73, 100, 88, 1610, 26, 2, true],
    [domain2.id, 'outreach@yoursolutions.co', 'Ilhaan Najar', 'warming', 22, 35, 61, 310, 9, 1, false],
    [domain2.id, 'team@yoursolutions.co', 'Acme Outsourcing Team', 'warming', 21, 35, 58, 290, 11, 1, false],
  ];

  for (const [domainId, email, name, status, sentToday, limit, rep, total, bounced, complaints, warm] of inboxes) {
    await sql`
      INSERT INTO sending_inboxes (organization_id, domain_id, email_address, display_name,
        status, provider, daily_send_limit, max_daily_send_limit, sent_today,
        sent_today_reset_at, reputation_score, total_sent, total_bounced, total_complaints,
        warmup_started_at, warmup_completed, last_sent_at)
      VALUES (${orgId}, ${domainId}, ${email}, ${name}, ${status}, 'console', ${limit}, 100,
        ${sentToday}, NOW(), ${rep}, ${total}, ${bounced}, ${complaints},
        NOW() - INTERVAL '28 days', ${warm}, NOW() - INTERVAL '2 hours')
      ON CONFLICT (email_address) DO NOTHING`;
  }

  // ── Campaign ─────────────────────────────────────────────────────────
  const [campaign] = await sql`
    INSERT INTO campaigns (organization_id, name, description, status, target_role,
      target_industry, target_location, max_follow_ups, follow_up_1_delay_days,
      follow_up_2_delay_days, custom_prompt_additions, started_at)
    VALUES (${orgId}, 'Q3 — UK finance & back-office', 'Companies hiring AR, payroll, and back-office staff',
      'active', 'CFO, Finance Manager, Operations Lead', 'Logistics, Manufacturing', 'United Kingdom',
      2, 4, 7, 'These are UK companies — use British spelling. Reference the specific roles they are hiring for.',
      NOW() - INTERVAL '21 days')
    RETURNING id`;

  const campaignId = campaign.id;
  const leadIds = [];
  const [firstInbox] = await sql`SELECT id, email_address, display_name FROM sending_inboxes WHERE organization_id = ${orgId} LIMIT 1`;

  // ── Companies, contacts, leads ───────────────────────────────────────
  for (let i = 0; i < COMPANIES.length; i++) {
    const [name, domainName, industry, size, location, signal] = COMPANIES[i];
    const [first, last, title, dept, seniority] = CONTACTS[i];

    const [company] = await sql`
      INSERT INTO companies (organization_id, name, domain, website, industry, size_range,
        location, country, hiring_signal, hiring_signal_source, hiring_signal_seen_at, source)
      VALUES (${orgId}, ${name}, ${domainName}, ${'https://' + domainName}, ${industry},
        ${size}, ${location}, 'United Kingdom', ${signal}, 'csv_import',
        NOW() - INTERVAL '10 days', 'csv_import')
      ON CONFLICT (organization_id, domain) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`;

    const email = `${first.toLowerCase()}.${last.toLowerCase()}@${domainName}`;
    const [contact] = await sql`
      INSERT INTO contacts (organization_id, company_id, first_name, last_name, full_name,
        email, job_title, department, seniority, email_verified, email_verification_status,
        email_verification_score, email_verified_at, source)
      VALUES (${orgId}, ${company.id}, ${first}, ${last}, ${first + ' ' + last}, ${email},
        ${title}, ${dept}, ${seniority}, true, 'valid', ${85 + (i % 12)}, NOW(), 'csv_import')
      ON CONFLICT (organization_id, email) DO UPDATE SET job_title = EXCLUDED.job_title
      RETURNING id`;

    // Everything except the last two gets research; those stay 'new' so the
    // "needs research" state is visible on the leads page.
    let researchId = null;
    if (i < COMPANIES.length - 2) {
      const [research] = await sql`
        INSERT INTO ai_research (organization_id, company_id, summary, pain_points,
          opportunities, value_proposition, personalization_hooks, fit_score,
          hook_quality_score, disqualifiers, model, input_tokens,
          output_tokens, cost_usd, is_stale, created_at)
        VALUES (${orgId}, ${company.id}, ${RESEARCH.summary},
          ${sql.json(RESEARCH.painPoints)},
          ${sql.json(RESEARCH.opportunities)},
          ${RESEARCH.valueProp},
          ${sql.json(RESEARCH.hooks)},
          ${82}, ${RESEARCH.hooks[0].score}, ${sql.json(RESEARCH.disqualifiers)},
          'claude-haiku-4-5', 1180, 430, 0.003330, false, NOW() - INTERVAL '6 days')
        RETURNING id`;
      researchId = research.id;
    }

    // Spread leads across the funnel so every status filter has rows.
    const statuses = [
      'interested', 'ready_to_contact', 'follow_up_1_sent', 'contacted',
      'ready_to_contact', 'not_interested', 'contacted', 'researched', 'new', 'new',
    ];
    const status = statuses[i];
    const contacted = ['interested', 'follow_up_1_sent', 'contacted', 'not_interested'].includes(status);
    const attention = status === 'interested' || status === 'ready_to_contact';

    const [lead] = await sql`
      INSERT INTO leads (organization_id, company_id, contact_id, campaign_id, status,
        priority, research_id, follow_up_count, next_follow_up_at, first_contacted_at,
        last_contacted_at, replied_at, requires_attention, attention_reason, created_at)
      VALUES (${orgId}, ${company.id}, ${contact.id}, ${campaignId}, ${status},
        ${attention ? 10 : 0}, ${researchId},
        ${status === 'follow_up_1_sent' ? 1 : 0},
        ${status === 'contacted' ? sql`NOW() + INTERVAL '2 days'` : null},
        ${contacted ? sql`NOW() - INTERVAL '8 days'` : null},
        ${contacted ? sql`NOW() - INTERVAL '5 days'` : null},
        ${['interested', 'not_interested'].includes(status) ? sql`NOW() - INTERVAL '2 days'` : null},
        ${attention},
        ${status === 'interested' ? 'Positive reply — respond and book the call'
          : status === 'ready_to_contact' ? 'Draft waiting for approval' : null},
        NOW() - INTERVAL '14 days')
      ON CONFLICT (organization_id, contact_id, campaign_id) DO NOTHING
      RETURNING id`;

    if (!lead) continue;
    leadIds.push({ id: lead.id, status, first, email, index: i });
  }

  // ── Emails ───────────────────────────────────────────────────────────
  let sentCount = 0;
  for (const lead of leadIds) {
    const template = EMAIL_BODIES[lead.index % EMAIL_BODIES.length];
    const body = template.body.replace('{first}', lead.first);

    if (lead.status === 'ready_to_contact') {
      // Drafts awaiting approval — these populate the approval queue.
      await sql`
        INSERT INTO emails (organization_id, lead_id, kind, status, subject, body_text,
          original_subject, original_body_text, to_address, model, input_tokens,
          output_tokens, cost_usd, created_at)
        VALUES (${orgId}, ${lead.id}, 'initial', 'pending_approval', ${template.subject},
          ${body}, ${template.subject}, ${body}, ${lead.email}, 'claude-sonnet-5',
          1420, 310, 0.008910, NOW() - INTERVAL '3 hours')`;
    } else if (['interested', 'contacted', 'follow_up_1_sent', 'not_interested'].includes(lead.status)) {
      const [sent] = await sql`
        INSERT INTO emails (organization_id, lead_id, inbox_id, kind, status, subject,
          body_text, original_subject, original_body_text, from_address, to_address,
          approved_by, approved_at, sent_at, provider, provider_message_id,
          message_id_header, thread_id, model, input_tokens, output_tokens, cost_usd,
          open_count, created_at)
        VALUES (${orgId}, ${lead.id}, ${firstInbox.id}, 'initial', 'delivered',
          ${template.subject}, ${body}, ${template.subject}, ${body},
          ${firstInbox.email_address}, ${lead.email}, ${userId},
          NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days', 'console',
          ${'msg-' + lead.id.slice(0, 8)}, ${'msg-' + lead.id.slice(0, 8)},
          ${'msg-' + lead.id.slice(0, 8)}, 'claude-sonnet-5', 1420, 310, 0.008910,
          ${lead.status === 'interested' ? 3 : 1}, NOW() - INTERVAL '9 days')
        RETURNING id`;
      sentCount++;

      await sql`
        INSERT INTO email_events (organization_id, email_id, event_type, provider,
          provider_event_id, occurred_at)
        VALUES (${orgId}, ${sent.id}, 'delivered', 'console',
          ${'evt-' + sent.id.slice(0, 8)}, NOW() - INTERVAL '8 days')
        ON CONFLICT (provider, provider_event_id) DO NOTHING`;

      if (lead.status === 'follow_up_1_sent') {
        await sql`
          INSERT INTO emails (organization_id, lead_id, inbox_id, kind, status, subject,
            body_text, from_address, to_address, approved_by, approved_at, sent_at,
            provider, provider_message_id, in_reply_to, thread_id, model, input_tokens,
            output_tokens, cost_usd, created_at)
          VALUES (${orgId}, ${lead.id}, ${firstInbox.id}, 'follow_up_1', 'delivered',
            ${'Re: ' + template.subject},
            ${'Hi ' + lead.first + ",\n\nOne more angle — most of the firms we work with start with just invoice processing rather than the whole finance function. Smaller commitment, and it covers the volume problem straight away.\n\nStill happy to talk if useful.\n\nIlhaan"},
            ${firstInbox.email_address}, ${lead.email}, ${userId},
            NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days', 'console',
            ${'msg-fu-' + lead.id.slice(0, 8)}, ${'msg-' + lead.id.slice(0, 8)},
            ${'msg-' + lead.id.slice(0, 8)}, 'claude-haiku-4-5', 980, 180, 0.001880,
            NOW() - INTERVAL '4 days')`;
        sentCount++;
      }
    }
  }

  // ── Replies ──────────────────────────────────────────────────────────
  const replyLeads = leadIds.filter((l) => ['interested', 'not_interested'].includes(l.status)).slice(0, 3);
  for (let i = 0; i < replyLeads.length; i++) {
    const lead = replyLeads[i];
    const reply = REPLIES[i % REPLIES.length];
    const [email] = await sql`SELECT id, subject FROM emails WHERE lead_id = ${lead.id} AND status = 'delivered' LIMIT 1`;

    await sql`
      INSERT INTO replies (organization_id, lead_id, email_id, from_address, subject,
        body_text, classification, classification_confidence, classification_reasoning,
        summary, model, input_tokens, output_tokens, cost_usd, is_handled, received_at)
      VALUES (${orgId}, ${lead.id}, ${email?.id ?? null}, ${lead.email},
        ${'Re: ' + (email?.subject ?? 'your email')}, ${reply.body},
        ${reply.classification}, ${reply.confidence}, ${reply.reasoning}, ${reply.summary},
        'claude-haiku-4-5', 720, 140, 0.001420, false, NOW() - INTERVAL '2 days')`;
  }

  // ── AI usage history (drives the cost meter and charts) ──────────────
  const period = new Date().toISOString().slice(0, 7);
  const usage = [
    ['research', 'claude-haiku-4-5', 1180, 430, 0.003330, 62],
    ['email_generation', 'claude-sonnet-5', 1420, 310, 0.008910, 48],
    ['follow_up_generation', 'claude-haiku-4-5', 980, 180, 0.001880, 31],
    ['reply_classification', 'claude-haiku-4-5', 720, 140, 0.001420, 24],
  ];

  for (const [operation, model, inTok, outTok, cost, count] of usage) {
    for (let i = 0; i < count; i++) {
      await sql`
        INSERT INTO ai_usage (organization_id, operation, model, input_tokens, output_tokens,
          cost_usd, billing_period, duration_ms, success, created_at)
        VALUES (${orgId}, ${operation}, ${model}, ${inTok}, ${outTok}, ${cost}, ${period},
          ${900 + (i % 700)}, true, NOW() - (${i % 21} * INTERVAL '1 day'))`;
    }
  }

  // ── Health + notifications ───────────────────────────────────────────
  for (const [component, status, ms] of [['database', 'operational', 4], ['ai', 'operational', 412], ['email', 'operational', 168], ['enrichment', 'operational', 233]]) {
    await sql`
      INSERT INTO system_health (component, status, last_checked_at, last_success_at,
        consecutive_failures, response_time_ms, updated_at)
      VALUES (${component}, ${status}, NOW(), NOW(), 0, ${ms}, NOW())
      ON CONFLICT (component) DO UPDATE SET status = EXCLUDED.status,
        last_checked_at = NOW(), response_time_ms = EXCLUDED.response_time_ms, updated_at = NOW()`;
  }

  const notifications = [
    ['tier_3_stopped', 'both', 'Interested: Northwind Logistics', 'James Alvarez replied with interest.\n\nActively considering the offer and asking for details plus a call this week.\n\nSuggested next step: Reply with the AR breakdown and confirm Thursday.', '/leads', 'Open lead and reply', true, '25 minutes'],
    ['tier_2_auto_notified', 'dashboard', 'AI budget at 62%', '$12.40 of $20.00 used this month. $7.60 remaining before AI operations stop.', '/settings/ai', 'Review AI spend', false, '3 hours'],
    ['tier_1_auto_fixed', 'dashboard', 'Warm-up limits increased', 'outreach@yoursolutions.co: 20 → 35/day\nteam@yoursolutions.co: 20 → 35/day', null, null, false, '9 hours'],
    ['tier_2_auto_notified', 'dashboard', 'Unsubscribe honoured: Harbour Point Retail', 'The contact asked to be removed. They are suppressed and will not be emailed again.', null, null, false, '1 day'],
    ['tier_1_auto_fixed', 'dashboard', 'Stalled jobs recovered', '2 jobs were stuck on a worker that stopped responding. They have been returned to the queue.', null, null, false, '2 days'],
  ];

  for (const [tier, channel, title, message, url, label, emailed, ago] of notifications) {
    await sql`
      INSERT INTO notifications (organization_id, tier, channel, title, message, action_url,
        action_label, is_read, email_sent, email_sent_at, created_at)
      VALUES (${orgId}, ${tier}, ${channel}, ${title}, ${message}, ${url}, ${label}, false,
        ${emailed}, ${emailed ? sql`NOW()` : null}, NOW() - ${ago}::interval)`;
  }

  // ── Background jobs ──────────────────────────────────────────────────
  for (const [type, status, ago, err] of [
    ['research_company', 'completed', '2 hours', null],
    ['generate_email', 'completed', '3 hours', null],
    ['send_email', 'completed', '5 hours', null],
    ['classify_reply', 'completed', '2 days', null],
    ['health_check', 'completed', '8 minutes', null],
    ['check_follow_ups_due', 'pending', '0 minutes', null],
    ['research_company', 'dead', '1 day', 'Anthropic API rate limit exceeded after 3 attempts'],
  ]) {
    await sql`
      INSERT INTO background_jobs (organization_id, type, status, payload, attempts,
        max_attempts, run_at, started_at, completed_at, duration_ms, last_error, created_at)
      VALUES (${orgId}, ${type}, ${status}, '{}'::jsonb,
        ${status === 'dead' ? 3 : status === 'pending' ? 0 : 1}, 3,
        NOW() - ${ago}::interval,
        ${status === 'pending' ? null : sql`NOW() - ${ago}::interval`},
        ${['completed', 'dead'].includes(status) ? sql`NOW() - ${ago}::interval` : null},
        ${status === 'completed' ? 1400 : null}, ${err}, NOW() - ${ago}::interval)`;
  }

  // ── Audit log ────────────────────────────────────────────────────────
  for (const [action, entity, meta, ago] of [
    ['email.bulk_approve', 'email', { approvedCount: 12, skippedCount: 0 }, '5 hours'],
    ['lead.import', 'lead', { imported: 10, duplicates: 0, filename: 'uk-logistics-q3.csv' }, '14 days'],
    ['domain.create', 'sending_domain', { domain: 'yoursolutions.co', dnsPassing: false }, '13 days'],
    ['settings.ai_update', 'ai_config', { budgetStop: 20 }, '20 days'],
    ['campaign.create', 'campaign', { name: 'Q3 — UK finance & back-office' }, '21 days'],
  ]) {
    await sql`
      INSERT INTO audit_logs (organization_id, user_id, action, entity_type, metadata,
        ip_address, created_at)
      VALUES (${orgId}, ${userId}, ${action}, ${entity}, ${sql.json(meta)},
        '203.0.113.42', NOW() - ${ago}::interval)`;
  }

  const [counts] = await sql`
    SELECT (SELECT COUNT(*) FROM leads WHERE organization_id = ${orgId})::int AS leads,
           (SELECT COUNT(*) FROM emails WHERE organization_id = ${orgId})::int AS emails,
           (SELECT COUNT(*) FROM replies WHERE organization_id = ${orgId})::int AS replies`;

  console.log(`
  Demo data ready
  ────────────────────────────────────────────────
  ${counts.leads} leads · ${counts.emails} emails · ${counts.replies} replies
  2 sending domains · 4 inboxes · 1 campaign
  ${sentCount} emails sent · drafts waiting in the approval queue
`);

  await sql.end();
}

main().catch((error) => {
  console.error('Demo data failed:', error);
  process.exit(1);
});
