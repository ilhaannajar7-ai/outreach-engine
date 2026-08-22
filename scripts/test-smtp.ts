/**
 * Manual SMTP connectivity + send test.
 *
 * Verifies the Zoho (or any) SMTP credentials in .env can connect and actually
 * deliver a message, using the app's real SmtpEmailService — so a green run here
 * means the send path the worker uses is working end to end.
 *
 *   npx tsx scripts/test-smtp.ts you@example.com
 */

import { SmtpEmailService } from '../src/lib/providers/email/smtp';

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: npx tsx scripts/test-smtp.ts <recipient@email.com>');
    process.exit(1);
  }

  const svc = new SmtpEmailService();

  console.log('1. Verifying SMTP connection (host/port/user/app-password)…');
  const health = await svc.healthCheck();
  console.log('   ', health);
  if (!health.ok) {
    console.error('   ❌ Connection failed. Check SMTP_HOST/PORT/USER/PASSWORD in .env.');
    process.exit(1);
  }
  console.log('   ✓ Connected.\n');

  console.log(`2. Sending a test email to ${to}…`);
  const result = await svc.send({
    from: 'admin@gothamoutsourcing.net',
    fromName: 'GothamIP Outreach',
    to,
    subject: 'SMTP test — Outreach Engine',
    text:
      "This is a test email sent through the app's Zoho SMTP sender.\n" +
      'If you received this, sending works end to end.',
  });
  console.log('   ✓ Sent!', result);
  console.log('\nCheck the recipient inbox (and Spam) for the test email.');
}

main().catch((e) => {
  console.error('❌ FAILED:', e);
  process.exit(1);
});
