import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubEmail } from '@/utils/scrub/email';
import { rescoreLead } from '@/utils/scoring/rescore';

/**
 * POST /api/harvest-emails
 *   body: { client_slug: string, limit?: number, segment?: string }
 *
 * For leads where we have a website (scraped from Google Places / OSM) but
 * no email yet, fetch the site + /contact + /about and extract emails via
 * regex. Handles common obfuscation ([at]/(at), [dot]/(dot), HTML entities).
 *
 * Pattern inspired by OneClickIT-ai/ritac-security-scanner's email_harvester.py.
 * This is a free supplement to Hunter/Snov — catches long-tail salons whose
 * emails don't live in Hunter's index but are printed on their own homepage.
 */

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/contact.html', '/about', '/about-us'];
const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_RX = /mailto:([^"'?\s>]+)/gi;
const OBFUSCATION_RX =
  /([a-zA-Z0-9._%+-]+)\s*[\[(]\s*at\s*[\])]\s*([a-zA-Z0-9.-]+)\s*[\[(]\s*dot\s*[\])]\s*([a-zA-Z]{2,})/gi;

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

  const { client_slug, limit = 50, segment } = await req.json();
  if (!client_slug) return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', client_slug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  // Leads with a website (in raw->source_url) but no email yet.
  let q = supabase
    .from('leads')
    .select('id, company, city, region, raw')
    .eq('client_id', client.id)
    .is('email', null)
    .not('raw->>source_url', 'is', null)
    .limit(limit);
  if (segment) q = q.eq('icp_segment', segment);

  const { data: leads, error: qErr } = await q;
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  if (!leads?.length) return NextResponse.json({ checked: 0, updated: 0, sites: [] });

  const results: HarvestResult[] = [];
  let rescored = 0;
  // Limited concurrency — be polite to small salon sites.
  const pool = 4;
  const queue = [...leads];
  async function worker() {
    while (queue.length) {
      const lead = queue.shift();
      if (!lead) break;
      const site = (lead.raw as { source_url?: string } | null)?.source_url;
      if (!site) continue;
      const hit = await harvestSite(site);
      results.push({ lead_id: lead.id, company: lead.company, site, ...hit });
      if (!hit.email) continue;

      // Validate the harvested email through the same pipeline scrubEmail
      // uses at ingest, so identity/MX/disposable flags are honest and the
      // rescore reflects reality.
      const scrub = await scrubEmail(hit.email);
      const isScrubbed =
        scrub.syntax_valid && scrub.mx_valid && !scrub.is_disposable;
      const now = new Date().toISOString();
      const { error: upErr } = await supabase
        .from('leads')
        .update({
          email: scrub.normalized || hit.email,
          syntax_valid: scrub.syntax_valid,
          mx_valid: scrub.mx_valid,
          smtp_valid: scrub.smtp_valid,
          is_disposable: scrub.is_disposable,
          scrub_score: scrub.score,
          reject_reason: scrub.reject_reason ?? null,
          is_scrubbed: isScrubbed,
          scrubbed_at: now,
          raw: { ...(lead.raw as object), harvested_from: hit.found_on },
        })
        .eq('id', lead.id);
      if (upErr) continue;

      const res = await rescoreLead(supabase as never, lead.id, {
        verifiedAt: now,
        verifiedBy: 'harvest-emails',
      });
      if (res?.updated) rescored++;
    }
  }
  await Promise.all(Array.from({ length: pool }, worker));

  const updated = results.filter((r) => r.email).length;
  return NextResponse.json({
    checked: results.length,
    updated,
    rescored,
    sites: results.slice(0, 25),
  });
}

interface HarvestResult {
  lead_id: string;
  company: string | null;
  site: string;
  email?: string;
  found_on?: string;
  candidates?: string[];
}

async function harvestSite(siteUrl: string): Promise<Partial<HarvestResult>> {
  const base = normalizeUrl(siteUrl);
  if (!base) return {};
  const found: { email: string; source: string }[] = [];

  for (const path of CONTACT_PATHS) {
    const target = base + path;
    const html = await fetchText(target);
    if (!html) continue;
    for (const e of extractEmails(html)) {
      if (isLikelyJunk(e)) continue;
      if (!found.find((f) => f.email === e)) found.push({ email: e, source: target });
    }
    // Bail early once we have a good hit on homepage or /contact.
    if (found.length && path) break;
  }

  if (!found.length) return { candidates: [] };
  const primary = pickPrimary(found.map((f) => f.email), base);
  const src = found.find((f) => f.email === primary)?.source;
  return { email: primary, found_on: src, candidates: found.map((f) => f.email).slice(0, 5) };
}

function extractEmails(html: string): string[] {
  const decoded = html
    .replace(/&#64;|&#x40;/gi, '@')
    .replace(/&#46;|&#x2e;/gi, '.')
    .replace(/&amp;/g, '&');

  const out = new Set<string>();
  for (const m of decoded.matchAll(MAILTO_RX)) {
    const raw = decodeURIComponent(m[1].split('?')[0]).trim().toLowerCase();
    if (EMAIL_RX.test(raw)) out.add(raw);
    EMAIL_RX.lastIndex = 0;
  }
  for (const m of decoded.matchAll(EMAIL_RX)) {
    out.add(m[0].toLowerCase().replace(/\.$/, ''));
  }
  for (const m of decoded.matchAll(OBFUSCATION_RX)) {
    out.add(`${m[1]}@${m[2]}.${m[3]}`.toLowerCase());
  }
  return [...out];
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

function pickPrimary(emails: string[], siteUrl: string): string {
  const host = new URL(siteUrl).hostname.replace(/^www\./, '');
  const apex = host.split('.').slice(-2).join('.');
  // Prefer emails on the same domain as the website.
  const onDomain = emails.filter((e) => e.endsWith('@' + host) || e.endsWith('@' + apex));
  const pool = onDomain.length ? onDomain : emails;
  // Prefer info@/hello@/contact@ over owner names.
  const priority = ['info', 'hello', 'contact', 'sales', 'bookings', 'appointments'];
  for (const p of priority) {
    const hit = pool.find((e) => e.startsWith(p + '@'));
    if (hit) return hit;
  }
  return pool[0];
}

function normalizeUrl(u: string): string | null {
  try {
    const url = new URL(u.startsWith('http') ? u : 'https://' + u);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'OneClickitLeadsBot/1.0 (+https://oneclickitleads.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('text')) return null;
    return (await resp.text()).slice(0, 500_000); // cap at 500KB
  } catch {
    return null;
  }
}
