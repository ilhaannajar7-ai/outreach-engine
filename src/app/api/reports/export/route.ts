/**
 * Weekly / monthly report export as a real .xlsx workbook.
 *
 * One sheet per subject rather than a single wide dump, because these get read
 * by people, not parsers: Summary for the headline numbers, then the funnel,
 * inbox health, AI spend, API usage, and the underlying rows the totals came
 * from. Streams straight from the request — nothing is written to disk.
 */

import ExcelJS from 'exceljs';
import { db } from '@/db';
import { emails, leads, companies, contacts, replies } from '@/db/schema';
import { and, eq, gte, desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/api-helpers';
import { getAnalyticsReport } from '@/lib/queries/analytics';

export const dynamic = 'force-dynamic';

const PERIODS: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 90 };

export async function GET(request: Request) {
  const ctx = await requireAuth();
  const url = new URL(request.url);
  const periodKey = url.searchParams.get('period') ?? 'monthly';
  const days = PERIODS[periodKey] ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [report, emailRows, leadRows, replyRows] = await Promise.all([
    getAnalyticsReport(ctx.organizationId, days),
    db
      .select({
        sentAt: emails.sentAt,
        status: emails.status,
        kind: emails.kind,
        to: emails.toAddress,
        from: emails.fromAddress,
        subject: emails.subject,
      })
      .from(emails)
      .where(and(eq(emails.organizationId, ctx.organizationId), gte(emails.createdAt, since)))
      .orderBy(desc(emails.createdAt))
      .limit(5000),
    db
      .select({
        company: companies.name,
        domain: companies.domain,
        hiringSignal: companies.hiringSignal,
        source: companies.hiringSignalSource,
        contactName: contacts.fullName,
        contactEmail: contacts.email,
        jobTitle: contacts.jobTitle,
        status: leads.status,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .innerJoin(companies, eq(leads.companyId, companies.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(and(eq(leads.organizationId, ctx.organizationId), gte(leads.createdAt, since)))
      .orderBy(desc(leads.createdAt))
      .limit(5000),
    db
      .select({
        receivedAt: replies.receivedAt,
        from: replies.fromAddress,
        classification: replies.classification,
        subject: replies.subject,
      })
      .from(replies)
      .where(and(eq(replies.organizationId, ctx.organizationId), gte(replies.receivedAt, since)))
      .orderBy(desc(replies.receivedAt))
      .limit(5000),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Outreach Engine';
  wb.created = new Date();

  const pct = (n: number) => Number(n.toFixed(2));

  // --- Summary ------------------------------------------------------------
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 34 },
    { header: 'Value', key: 'value', width: 18 },
    { header: 'Notes', key: 'note', width: 60 },
  ];
  summary.addRows([
    { metric: 'Report period', value: `${days} days`, note: `Since ${since.toISOString().slice(0, 10)}` },
    { metric: 'Generated', value: new Date().toISOString().slice(0, 16).replace('T', ' '), note: '' },
    { metric: '', value: '', note: '' },
    { metric: 'Emails approved', value: report.funnel.approved, note: 'Every send is human-approved' },
    { metric: 'Emails sent', value: report.funnel.sent, note: '' },
    { metric: 'Delivered', value: report.funnel.delivered, note: 'Requires provider webhook' },
    { metric: 'Opened', value: report.funnel.opened, note: 'Undercounts — many clients block pixels' },
    { metric: 'Replies', value: report.funnel.replied, note: 'The metric that matters most' },
    { metric: 'Interested replies', value: report.funnel.interested, note: '' },
    { metric: 'Bounced', value: report.funnel.bounced, note: 'Keep under 3%' },
    { metric: 'Spam complaints', value: report.funnel.complained, note: 'Keep under 0.1%' },
    { metric: '', value: '', note: '' },
    { metric: 'Delivery rate %', value: pct(report.funnel.deliveryRate), note: '' },
    { metric: 'Open rate %', value: pct(report.funnel.openRate), note: 'Treat as a floor' },
    { metric: 'Reply rate %', value: pct(report.funnel.replyRate), note: '3–5% is healthy cold outreach' },
    { metric: 'Interested rate %', value: pct(report.funnel.interestedRate), note: '' },
    { metric: 'Bounce rate %', value: pct(report.funnel.bounceRate), note: '' },
    { metric: 'Complaint rate %', value: pct(report.funnel.complaintRate), note: '' },
    { metric: '', value: '', note: '' },
    { metric: 'AI spend (USD)', value: Number(report.aiTotalCost.toFixed(4)), note: 'Anthropic, this period' },
    { metric: 'Companies in database', value: report.database.companies, note: '' },
    { metric: '— auto-sourced', value: report.database.sourcedCompanies, note: '' },
    { metric: 'Contacts', value: report.database.contacts, note: '' },
    { metric: 'Leads', value: report.database.leads, note: '' },
    { metric: 'Emails (all time)', value: report.database.emails, note: '' },
    { metric: 'Replies (all time)', value: report.database.replies, note: '' },
  ]);

  // --- Inbox health -------------------------------------------------------
  const inboxSheet = wb.addWorksheet('Inbox health');
  inboxSheet.columns = [
    { header: 'Mailbox', key: 'emailAddress', width: 34 },
    { header: 'Domain', key: 'domain', width: 26 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Provider', key: 'provider', width: 12 },
    { header: 'Reputation', key: 'reputationScore', width: 12 },
    { header: 'Warm-up day', key: 'warmupDay', width: 13 },
    { header: 'Daily limit', key: 'dailyLimit', width: 12 },
    { header: 'Max limit', key: 'maxDailyLimit', width: 11 },
    { header: 'Sent today', key: 'sentToday', width: 11 },
    { header: 'Total sent', key: 'totalSent', width: 11 },
    { header: 'Bounced', key: 'totalBounced', width: 10 },
    { header: 'Bounce %', key: 'bounceRate', width: 10 },
  ];
  inboxSheet.addRows(
    report.inboxes.map((i) => ({ ...i, bounceRate: pct(i.bounceRate), warmupDay: i.warmupDay ?? '—' })),
  );

  // --- AI spend -----------------------------------------------------------
  const aiSheet = wb.addWorksheet('AI usage');
  aiSheet.columns = [
    { header: 'Operation', key: 'operation', width: 24 },
    { header: 'Model', key: 'model', width: 24 },
    { header: 'Calls', key: 'calls', width: 10 },
    { header: 'Input tokens', key: 'inputTokens', width: 14 },
    { header: 'Output tokens', key: 'outputTokens', width: 14 },
    { header: 'Cost (USD)', key: 'costUsd', width: 13 },
  ];
  aiSheet.addRows(report.aiSpend.map((r) => ({ ...r, costUsd: Number(r.costUsd.toFixed(4)) })));

  // --- API usage ----------------------------------------------------------
  const apiSheet = wb.addWorksheet('API usage');
  apiSheet.columns = [
    { header: 'Provider', key: 'provider', width: 20 },
    { header: 'Calls', key: 'calls', width: 12 },
    { header: 'Credits used', key: 'credits', width: 14 },
    { header: 'Failures', key: 'failures', width: 12 },
  ];
  apiSheet.addRows(report.apiUsage);

  // --- Daily sends --------------------------------------------------------
  const dailySheet = wb.addWorksheet('Daily sends');
  dailySheet.columns = [
    { header: 'Day', key: 'day', width: 14 },
    { header: 'Sent', key: 'sent', width: 10 },
  ];
  dailySheet.addRows(report.dailySends);

  // --- Detail sheets ------------------------------------------------------
  const emailSheet = wb.addWorksheet('Emails');
  emailSheet.columns = [
    { header: 'Sent at', key: 'sentAt', width: 20 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Kind', key: 'kind', width: 14 },
    { header: 'To', key: 'to', width: 34 },
    { header: 'From', key: 'from', width: 34 },
    { header: 'Subject', key: 'subject', width: 60 },
  ];
  emailSheet.addRows(
    emailRows.map((e) => ({
      ...e,
      sentAt: e.sentAt ? e.sentAt.toISOString().slice(0, 16).replace('T', ' ') : '—',
    })),
  );

  const leadSheet = wb.addWorksheet('Leads');
  leadSheet.columns = [
    { header: 'Created', key: 'createdAt', width: 20 },
    { header: 'Company', key: 'company', width: 30 },
    { header: 'Domain', key: 'domain', width: 26 },
    { header: 'Contact', key: 'contactName', width: 26 },
    { header: 'Email', key: 'contactEmail', width: 34 },
    { header: 'Job title', key: 'jobTitle', width: 26 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Hiring signal', key: 'hiringSignal', width: 46 },
    { header: 'Source', key: 'source', width: 14 },
  ];
  leadSheet.addRows(
    leadRows.map((l) => ({
      ...l,
      createdAt: l.createdAt.toISOString().slice(0, 16).replace('T', ' '),
    })),
  );

  const replySheet = wb.addWorksheet('Replies');
  replySheet.columns = [
    { header: 'Received', key: 'receivedAt', width: 20 },
    { header: 'From', key: 'from', width: 34 },
    { header: 'Classification', key: 'classification', width: 20 },
    { header: 'Subject', key: 'subject', width: 60 },
  ];
  replySheet.addRows(
    replyRows.map((r) => ({
      ...r,
      receivedAt: r.receivedAt.toISOString().slice(0, 16).replace('T', ' '),
    })),
  );

  // Bold every header row and freeze it, so long sheets stay readable.
  wb.eachSheet((sheet) => {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  });

  const buffer = await wb.xlsx.writeBuffer();
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `outreach-${periodKey}-report-${stamp}.xlsx`;

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
