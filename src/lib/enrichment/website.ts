/**
 * Read a prospect's own website so research has real material to work with.
 *
 * Without this, research only sees the CSV row — a name, an industry, maybe a
 * job title — and the model has nothing company-specific to build on, so hooks
 * come out generic and the quality gate rejects them. Their homepage and about
 * page are the cheapest source of things that are true of *them*: what they do,
 * who they serve, how they describe themselves, how big they are.
 *
 * Deliberately conservative: short timeouts, a hard size cap, no JS execution,
 * no crawling beyond a couple of known paths. A prospect's site is untrusted
 * input — its text is passed to the model as reference material, never as
 * instructions, and the research prompt says so explicitly.
 */

const FETCH_TIMEOUT_MS = 8_000;
/** Bytes of HTML to download per page before giving up on it. */
const MAX_HTML_BYTES = 600_000;
/** Characters of extracted text to keep per page. */
const MAX_TEXT_PER_PAGE = 4_000;
/** Characters handed to the model in total. */
const MAX_TOTAL_TEXT = 6_000;

/** Paths worth trying, best first. Most sites answer on at least one. */
const CANDIDATE_PATHS = ['', '/about', '/about-us', '/services', '/what-we-do'];

export interface WebsiteContent {
  ok: boolean;
  url?: string;
  title?: string;
  metaDescription?: string;
  text: string;
  pagesRead: string[];
  error?: string;
}

/** Strip a fetched HTML document down to its readable prose. */
function extractText(html: string): { title: string; description: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]{0,500}?)["']/i,
  );

  const text = html
    // Remove anything that is not prose before touching the tags themselves.
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    // Keep block boundaries as spaces so words don't run together.
    .replace(/<\/(p|div|section|li|h[1-6]|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  return {
    title: decodeEntities(titleMatch?.[1] ?? '').trim(),
    description: decodeEntities(descMatch?.[1] ?? '').trim(),
    text: text.slice(0, MAX_TEXT_PER_PAGE),
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Identify honestly. A site that blocks this is telling us not to read it.
        'User-Agent': 'OutreachEngine/1.0 (+research; contact via website owner)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) return null;

    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('html')) return null;

    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_HTML_BYTES) return null;

    const html = await response.text();
    return html.slice(0, MAX_HTML_BYTES);
  } catch {
    return null;
  }
}

/**
 * Fetch what a company says about itself. Never throws — a site that is down,
 * slow, or blocking us simply yields `ok: false`, and research continues with
 * whatever else it has.
 */
export async function readCompanyWebsite(domain: string | null): Promise<WebsiteContent> {
  if (!domain) return { ok: false, text: '', pagesRead: [], error: 'No domain on record' };

  const clean = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];

  if (!clean || !clean.includes('.')) {
    return { ok: false, text: '', pagesRead: [], error: `"${domain}" is not a usable domain` };
  }

  const base = `https://${clean}`;
  const chunks: string[] = [];
  const pagesRead: string[] = [];
  let title = '';
  let metaDescription = '';

  for (const path of CANDIDATE_PATHS) {
    if (chunks.join('\n\n').length >= MAX_TOTAL_TEXT) break;

    const url = `${base}${path}`;
    const html = await fetchPage(url);
    if (!html) continue;

    const extracted = extractText(html);
    // A page that yields almost nothing is a shell (JS-rendered app, redirect
    // stub) and is not worth spending prompt space on.
    if (extracted.text.length < 200) continue;

    if (!title && extracted.title) title = extracted.title;
    if (!metaDescription && extracted.description) metaDescription = extracted.description;

    pagesRead.push(url);
    chunks.push(`--- ${url} ---\n${extracted.text}`);
  }

  if (chunks.length === 0) {
    return {
      ok: false,
      url: base,
      text: '',
      pagesRead: [],
      error: 'Could not read the site (blocked, offline, or entirely JavaScript-rendered)',
    };
  }

  return {
    ok: true,
    url: base,
    title,
    metaDescription,
    text: chunks.join('\n\n').slice(0, MAX_TOTAL_TEXT),
    pagesRead,
  };
}
