/**
 * SPF / DKIM / DMARC verification.
 *
 * Uses Node's DNS resolver directly — no third-party service, no cost. These
 * three records are what stand between your mail and the spam folder, so the
 * dashboard checks them on demand and on a schedule rather than trusting that
 * they were set up correctly once.
 */

import { Resolver } from 'node:dns/promises';
import type { DnsCheckResult } from './types';

const resolver = new Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

async function txtRecords(hostname: string): Promise<string[]> {
  try {
    const records = await resolver.resolveTxt(hostname);
    return records.map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

export async function checkSpf(domain: string): Promise<DnsCheckResult> {
  const records = await txtRecords(domain);
  const spf = records.find((r) => r.toLowerCase().startsWith('v=spf1'));

  if (!spf) {
    return {
      status: 'missing',
      message: 'No SPF record found. Add a TXT record at the root domain starting with "v=spf1".',
      record: null,
    };
  }

  // "+all" tells the world anyone may send as you — worse than having no SPF.
  if (/[+]all/i.test(spf)) {
    return {
      status: 'fail',
      message: 'SPF ends in "+all", which authorises any sender. Change it to "~all" or "-all".',
      record: spf,
    };
  }

  if (!/[~-]all/i.test(spf)) {
    return {
      status: 'fail',
      message: 'SPF has no "all" mechanism. Append "~all" (soft fail) or "-all" (hard fail).',
      record: spf,
    };
  }

  return { status: 'pass', message: 'SPF record is present and correctly terminated.', record: spf };
}

/**
 * DKIM lives at <selector>._domainkey.<domain>, and the selector is chosen by
 * whoever sends your mail — so we try the common ones.
 */
export async function checkDkim(domain: string, selectors?: string[]): Promise<DnsCheckResult> {
  const candidates = selectors ?? ['google', 'default', 'resend', 'smartlead', 'zmail', 'zoho', 'k1', 's1', 'mail'];

  for (const selector of candidates) {
    const records = await txtRecords(`${selector}._domainkey.${domain}`);
    const dkim = records.find((r) => r.toLowerCase().includes('v=dkim1') || r.includes('p='));

    if (dkim) {
      if (/p=(\s*;|\s*$)/.test(dkim)) {
        return {
          status: 'fail',
          message: `DKIM record at selector "${selector}" has an empty public key — the key was revoked.`,
          record: dkim,
        };
      }
      return {
        status: 'pass',
        message: `DKIM verified at selector "${selector}".`,
        record: dkim,
        selector,
      };
    }
  }

  return {
    status: 'missing',
    message:
      'No DKIM record found at the common selectors. Add the TXT record your email provider gave you.',
    record: null,
  };
}

export async function checkDmarc(domain: string): Promise<DnsCheckResult> {
  const records = await txtRecords(`_dmarc.${domain}`);
  const dmarc = records.find((r) => r.toLowerCase().startsWith('v=dmarc1'));

  if (!dmarc) {
    return {
      status: 'missing',
      message:
        'No DMARC record. Add a TXT record at _dmarc.' +
        domain +
        ' — start with "v=DMARC1; p=none; rua=mailto:you@' +
        domain +
        '".',
      record: null,
    };
  }

  const policy = dmarc.match(/p=(\w+)/i)?.[1]?.toLowerCase();

  if (!policy) {
    return {
      status: 'fail',
      message: 'DMARC record has no policy tag ("p="). It will be ignored by receivers.',
      record: dmarc,
    };
  }

  // p=none is valid and correct while warming; it just is not yet protective.
  if (policy === 'none') {
    return {
      status: 'pass',
      message:
        'DMARC is present with p=none (monitoring only). Move to p=quarantine once warm-up finishes.',
      record: dmarc,
    };
  }

  return { status: 'pass', message: `DMARC is present with policy p=${policy}.`, record: dmarc };
}

export async function checkMx(domain: string): Promise<DnsCheckResult> {
  try {
    const records = await resolver.resolveMx(domain);
    if (records.length === 0) {
      return { status: 'missing', message: 'No MX records — this domain cannot receive replies.', record: null };
    }
    const best = records.sort((a, b) => a.priority - b.priority)[0]!;
    return {
      status: 'pass',
      message: `MX records present (primary: ${best.exchange}).`,
      record: records.map((r) => `${r.priority} ${r.exchange}`).join(', '),
    };
  } catch {
    return { status: 'missing', message: 'No MX records — this domain cannot receive replies.', record: null };
  }
}

/** Run every check for a domain. */
export async function checkAllDns(
  domain: string,
  dkimSelectors?: string[],
): Promise<{
  spf: DnsCheckResult;
  dkim: DnsCheckResult;
  dmarc: DnsCheckResult;
  mx: DnsCheckResult;
  allPassing: boolean;
}> {
  const [spf, dkim, dmarc, mx] = await Promise.all([
    checkSpf(domain),
    checkDkim(domain, dkimSelectors),
    checkDmarc(domain),
    checkMx(domain),
  ]);

  return {
    spf,
    dkim,
    dmarc,
    mx,
    allPassing: [spf, dkim, dmarc, mx].every((r) => r.status === 'pass'),
  };
}
