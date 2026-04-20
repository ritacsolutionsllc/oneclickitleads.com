import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch } from '@/utils/scrub/pipeline';
import { toLeadColumns } from '@/lib/scoring/quality';

/**
 * POST /api/scrape-webscrapingai
 *   headers: { x-ingest-secret: $INGEST_SECRET }
 *   body: {
 *     client_slug: string;
 *     urls: string[];                        // pages to render + extract
 *     segment?: string;                      // ICP tag applied to inserts
 *     js_timeout?: number;                   // ms, default 2000
 *     timeout?: number;                      // ms, default 10000
 *     proxy?: 'datacenter' | 'residential';  // default 'datacenter'
 *   }
 *
 * Renders each URL through webscraping.ai (JS-rendered HTML + rotating
 * proxies) and extracts email/phone/social signals. Value add over
 * /api/scrape-osm and /api/harvest-emails: reaches directories that block
 * naive fetch (Yelp, Mindbody, StyleSeat, Instagram bios) where our best
 * beauty ICP leads live.
 */

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us'];
const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_RX = /mailto:([^"'?\s>]+)/gi;
const OBFUSCATION_RX =
  /([a-zA-Z0-9._%+-]+)\s*[\[(]\s*at\s*[\])]\s*([a-zA-Z0-9.-]+)\s*[\[(]\s*dot\s*[\])]\s*([a-zA-Z]{2,})/gi;
const PHONE_RX = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const INSTAGRAM_RX = /instagram\.com\/([A-Za-z0-9_.]{2,30})/i;
const FACEBOOK_RX = /facebook\.com\/([A-Za-z0-9.\-]{2,50})/i;
const TITLE_RX = /<title[^>]*>([^<]{1,200})<\/title>/i;

const JUNK_DOMAINS = new Set([
  'sentry.io', 'sentry.wixpress.com', 'wix.com', 'wixsite.com', 'squarespace.com',
  'godaddy.com', 'example.com', 'example.org', 'domain.com', 'email.com',
  'yourdomain.com', 'sample.com', 'test.com',
]);
const JUNK_LOCAL = new Set(['noreply', 'no-reply', 'donotreply', 'mailer-daemon', 'postmaster']);

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rawApiKey = process.env.WEBSCRAPINGAI_API_KEY;
  if (!rawApiKey)
    return NextResponse.json({ error: 'WEBSCRAPINGAI_API_KEY is not set' }, { status: 500 });
  const apiKey: string = rawApiKey;

  const body = await req.json().catch(() => ({}));
  const {
    client_slug,
    urls,
    segment,
    js_timeout = 2000,
    timeout = 10000,
    proxy = 'datacenter',
  } = body as {
    client_slug?: string;
    urls?: string[];
    segment?: string;
    js_timeout?: number;
    timeout?: number;
    proxy?: 'datacenter' | 'residential';
  };

  if (!client_slug)
    return NextResponse.json({ error: 'client_slug required' }, { status: 400 });
  if (!Array.isArray(urls) || urls.length === 0)
    return NextResponse.json({ error: 'urls[] required' }, { status: 400 });
  if (urls.length > 50)
    return NextResponse.json({ error: 'max 50 urls per request' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('slug', client_slug)
    .single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const { data: src } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: 'scraped',
      label: `webscraping.ai: ${urls.length} url${urls.length > 1 ? 's' : ''}${segment ? ` (${segment})` : ''}`,
      source_url: 'https://api.webscraping.ai/html',
    })
    .select('id')
    .single();

  // Limited concurrency — webscraping.ai credits aren't free.
  const pool = 4;
  const queue = [...urls];
  const rows: RawRow[] = [];
  const errors: { url: string; error: string }[] = [];

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      const normalized = normalizeUrl(url);
      if (!normalized) {
        errors.push({ url, error: 'invalid url' });
        continue;
      }
      try {
        const row = await scrapeOne(normalized, { apiKey, js_timeout, timeout, proxy });
        if (row) {
          row.icp_segment = segment;
          rows.push(row);
        }
      } catch (e) {
        errors.push({ url: normalized, error: (e as Error).message });
      }
    }
  }
  await Promise.all(Array.from({ length: pool }, worker));

  if (!rows.length) {
    return NextResponse.json({
      fetched: urls.length,
      extracted: 0,
      ingested: 0,
      errors,
    });
  }

  const scrubbed = await scrubBatch(supabase as never, client.id, rows, {
    sourceKind: 'webscraping_ai',
  });
  const toInsert = scrubbed.map((s) => ({
    client_id: client.id,
    source_id: src?.id,
    company: s.company,
    phone_e164: s.phone_e164,
    email: s.normalized_email || null,
    title: s.title,
    icp_segment: s.icp_segment,
    city: s.city,
    region: s.region,
    country: s.country,
    tags: s.tags ?? [],
    is_scrubbed: s.is_scrubbed,
    is_duplicate: s.is_duplicate,
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    scrub_score: s.scrub_score,
    reject_reason: s.reject_reason,
    raw: s,
    scrubbed_at: new Date().toISOString(),
    ...toLeadColumns(s.quality),
  }));
  const { error } = await supabase.from('leads').insert(toInsert);

  return NextResponse.json({
    fetched: urls.length,
    extracted: rows.length,
    with_email: rows.filter((r) => r.email).length,
    with_phone: rows.filter((r) => r.phone).length,
    ingested: toInsert.length,
    clean: toInsert.filter((r) => r.is_scrubbed).length,
    export_eligible: toInsert.filter((r) => r.export_eligible).length,
    quarantined: toInsert.filter((r) => r.review_state === 'quarantined').length,
    errors,
    error: error?.message,
  });
}

interface RawRow {
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  icp_segment?: string;
  source_url: string;
  tags: string[];
  instagram?: string;
  facebook?: string;
  [k: string]: unknown;
}

async function scrapeOne(
  targetUrl: string,
  opts: {
    apiKey: string;
    js_timeout: number;
    timeout: number;
    proxy: 'datacenter' | 'residential';
  }
): Promise<RawRow | null> {
  const base = new URL(targetUrl);

  // Try the target URL first; if no signals found, try /contact paths on the
  // same host. Each call burns a webscraping.ai credit, so we bail early on
  // first hit.
  const tried: string[] = [];
  const collected: {
    emails: string[];
    phones: string[];
    title?: string;
    instagram?: string;
    facebook?: string;
  } = { emails: [], phones: [] };

  for (const path of CONTACT_PATHS) {
    const fullUrl = path ? `${base.protocol}//${base.host}${path}` : targetUrl;
    tried.push(fullUrl);
    const html = await fetchViaWebscrapingAi(fullUrl, opts);
    if (!html) continue;
    const hit = extractSignals(html);
    collected.emails.push(...hit.emails);
    collected.phones.push(...hit.phones);
    collected.title = collected.title || hit.title;
    collected.instagram = collected.instagram || hit.instagram;
    collected.facebook = collected.facebook || hit.facebook;
    if (collected.emails.length) break;
    // Only probe extra paths when we hit the host root; otherwise respect
    // the caller's exact URL choice.
    if (path === '' && base.pathname !== '/' && base.pathname !== '') break;
  }

  const email = pickPrimaryEmail(collected.emails, base.host);
  const phone = collected.phones[0];
  if (!email && !phone) return null;

  const company =
    collected.title?.split(/[|\-–—·]/)[0]?.trim().slice(0, 120) ||
    base.host.replace(/^www\./, '');

  return {
    email,
    phone,
    company,
    source_url: tried[0],
    tags: ['webscraping.ai'],
    instagram: collected.instagram,
    facebook: collected.facebook,
  };
}

async function fetchViaWebscrapingAi(
  url: string,
  opts: {
    apiKey: string;
    js_timeout: number;
    timeout: number;
    proxy: 'datacenter' | 'residential';
  }
): Promise<string | null> {
  const qs = new URLSearchParams({
    api_key: opts.apiKey,
    url,
    timeout: String(opts.timeout),
    js_timeout: String(opts.js_timeout),
    proxy: opts.proxy,
  }).toString();

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout + 5000);
  try {
    const resp = await fetch(`https://api.webscraping.ai/html?${qs}`, {
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!resp.ok) return null;
    return (await resp.text()).slice(0, 500_000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractSignals(html: string) {
  const decoded = html
    .replace(/&#64;|&#x40;/gi, '@')
    .replace(/&#46;|&#x2e;/gi, '.')
    .replace(/&amp;/g, '&');

  const emails = new Set<string>();
  for (const m of decoded.matchAll(MAILTO_RX)) {
    const raw = decodeURIComponent(m[1].split('?')[0]).trim().toLowerCase();
    if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(raw)) emails.add(raw);
  }
  for (const m of decoded.matchAll(EMAIL_RX)) {
    emails.add(m[0].toLowerCase().replace(/\.$/, ''));
  }
  for (const m of decoded.matchAll(OBFUSCATION_RX)) {
    emails.add(`${m[1]}@${m[2]}.${m[3]}`.toLowerCase());
  }

  const phones = new Set<string>();
  for (const m of decoded.matchAll(PHONE_RX)) phones.add(m[0]);

  const title = decoded.match(TITLE_RX)?.[1]?.trim();
  const instagram = decoded.match(INSTAGRAM_RX)?.[1];
  const facebook = decoded.match(FACEBOOK_RX)?.[1];

  return {
    emails: [...emails].filter((e) => !isLikelyJunk(e)),
    phones: [...phones],
    title,
    instagram,
    facebook,
  };
}

function isLikelyJunk(email: string): boolean {
  const [local, domain] = email.split('@');
  if (!local || !domain) return true;
  if (JUNK_LOCAL.has(local)) return true;
  if (JUNK_DOMAINS.has(domain)) return true;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(domain)) return true;
  if (email.length > 120) return true;
  return false;
}

function pickPrimaryEmail(emails: string[], host: string): string | undefined {
  if (!emails.length) return undefined;
  const apex = host.replace(/^www\./, '').split('.').slice(-2).join('.');
  const onDomain = emails.filter((e) => e.endsWith('@' + host) || e.endsWith('@' + apex));
  const pool = onDomain.length ? onDomain : emails;
  const priority = ['info', 'hello', 'contact', 'sales', 'bookings', 'appointments'];
  for (const p of priority) {
    const hit = pool.find((e) => e.startsWith(p + '@'));
    if (hit) return hit;
  }
  return pool[0];
}

function normalizeUrl(u: string): string | null {
  try {
    const url = new URL(u.trim().startsWith('http') ? u.trim() : 'https://' + u.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
