import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch, scoringInsertFields } from '@/utils/scrub/pipeline';

/**
 * GET /api/lead-gen-salons?city=Los+Angeles&client=chella&segment=salon&limit=20
 *
 * All-in-one pipeline:
 *   1. Google Places text search → salons in <city>
 *   2. For each result with a website → crawl for contact emails
 *   3. Validate each email (syntax → MX → SMTP)
 *   4. Run full scrub pipeline (dedupe, suppression, scoring, tier)
 *   5. Upsert into leads table
 *
 * Auth: x-ingest-secret header (add INGEST_SECRET to Vercel env vars).
 * This endpoint is server-to-server / cron safe — no browser session needed.
 */

const VALID_SEGMENTS = ['salon', 'b2c_beauty', 'influencer', 'retailer'] as const;

// Contact page paths to crawl per domain
const CONTACT_PATHS = [
  '', '/contact', '/contact-us', '/about', '/about-us',
  '/team', '/book', '/booking', '/location',
];

const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_RX = /mailto:([^"'?\s>]+)/gi;
const JUNK_DOMAINS = new Set([
  'sentry.io', 'wix.com', 'squarespace.com', 'example.com',
  'godaddy.com', 'yourdomain.com', 'domain.com',
]);
const JUNK_LOCAL = new Set(['noreply', 'no-reply', 'donotreply', 'postmaster']);

export async function GET(req: NextRequest) {
  // Auth — server-side only, never exposed to browser
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const city = searchParams.get('city')?.slice(0, 100) ?? '';
  const clientSlug = searchParams.get('client')?.slice(0, 64) ?? '';
  const segment = (VALID_SEGMENTS as readonly string[]).includes(searchParams.get('segment') ?? '')
    ? (searchParams.get('segment') as typeof VALID_SEGMENTS[number])
    : 'salon';
  const limit = Math.min(60, Math.max(1, Number(searchParams.get('limit') ?? 20)));

  if (!city) return NextResponse.json({ error: 'city is required' }, { status: 400 });
  if (!clientSlug) return NextResponse.json({ error: 'client is required' }, { status: 400 });

  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!placesKey)
    return NextResponse.json({ error: 'GOOGLE_PLACES_API_KEY not set in Vercel env vars' }, { status: 500 });

  const supabase = createAdminClient();

  // Resolve client
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', clientSlug).single();
  if (!client)
    return NextResponse.json({ error: `client '${clientSlug}' not found` }, { status: 404 });

  // ── Step 1: Google Places search ──────────────────────────────────────────
  const fieldMask = [
    'places.id', 'places.displayName', 'places.addressComponents',
    'places.nationalPhoneNumber', 'places.websiteUri',
    'places.rating', 'places.userRatingCount', 'places.businessStatus',
    'places.types', 'nextPageToken',
  ].join(',');

  const placeResults: PlaceResult[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  const maxPages = Math.ceil(limit / 20);

  do {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': placesKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({
        textQuery: `salon ${city}`,
        pageSize: 20,
        ...(pageToken ? { pageToken } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return NextResponse.json({ error: `Places API error ${resp.status}`, detail: err.slice(0, 300) }, { status: 502 });
    }

    const data = await resp.json() as { places?: PlaceResult[]; nextPageToken?: string };
    placeResults.push(...(data.places ?? []).filter((p) => p.businessStatus === 'OPERATIONAL'));
    pageToken = data.nextPageToken;
    if (pageToken) await delay(2000);
    pages++;
  } while (pageToken && pages < maxPages);

  // ── Step 2: Crawl websites for emails ─────────────────────────────────────
  const rows: RawRow[] = [];

  const crawlQueue = placeResults.slice(0, limit);
  const CONCURRENCY = 4;
  const chunks = chunkArray(crawlQueue, CONCURRENCY);

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (place) => {
      const city_ = componentOf(place.addressComponents, ['locality', 'postal_town']);
      const region = componentShort(place.addressComponents, ['administrative_area_level_1']);
      const country = componentShort(place.addressComponents, ['country']) ?? 'US';
      const phone = place.nationalPhoneNumber ?? undefined;
      const website = place.websiteUri ?? undefined;

      let email: string | undefined;
      let emailSource: string | undefined;

      if (website) {
        const harvest = await crawlForEmail(website);
        if (harvest) { email = harvest.email; emailSource = harvest.source; }
      }

      rows.push({
        company: place.displayName?.text ?? undefined,
        phone,
        email,
        city: city_ ?? undefined,
        region: region ?? undefined,
        country,
        icp_segment: segment,
        tags: ['google_places', segment, ...(place.types ?? [])].slice(0, 10),
        source_url: website,
        email_source: emailSource,
        place_id: place.id,
        raw_rating: place.rating,
        raw_rating_count: place.userRatingCount,
      });
    }));
  }

  // ── Step 3: Scrub + score ──────────────────────────────────────────────────
  const scrubbed = await scrubBatch(supabase as never, client.id, rows);

  // ── Step 4: Upsert to leads ────────────────────────────────────────────────
  const { data: source } = await supabase
    .from('sources')
    .insert({ client_id: client.id, kind: 'scraped', label: `lead-gen-salons: ${city}`, source_url: 'https://places.googleapis.com' })
    .select('id').single();

  const toUpsert = scrubbed.map((s, i) => ({
    client_id: client.id,
    source_id: source?.id ?? null,
    company: s.company ?? null,
    phone_e164: s.phone_e164,
    email: s.normalized_email || null,
    title: null,
    icp_segment: s.icp_segment,
    city: s.city ?? null,
    region: s.region ?? null,
    country: s.country ?? null,
    tags: (s.tags as string[]) ?? [],
    is_scrubbed: s.is_scrubbed,
    is_duplicate: s.is_duplicate,
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    is_disposable: s.is_disposable,
    scrub_score: s.scrub_score,
    reject_reason: s.reject_reason ?? null,
    raw: { ...rows[i], ...s },
    scrubbed_at: new Date().toISOString(),
    ...scoringInsertFields(s),
  }));

  // Upsert on email uniqueness — skip duplicates silently
  const { error: upsertErr } = await supabase
    .from('leads')
    .upsert(toUpsert, { onConflict: 'client_id,email_hash', ignoreDuplicates: true });

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  const clean = scrubbed.filter((s) => s.is_scrubbed).length;
  const withEmail = rows.filter((r) => r.email).length;
  const withPhone = rows.filter((r) => r.phone).length;

  return NextResponse.json({
    city,
    client: clientSlug,
    segment,
    fetched: placeResults.length,
    with_phone: withPhone,
    with_email: withEmail,
    inserted: toUpsert.length,
    clean,
    skipped_duplicate: scrubbed.filter((s) => s.is_duplicate).length,
  });
}

// ── Types ──────────────────────────────────────────────────────────────────

interface PlaceResult {
  id?: string;
  displayName?: { text?: string };
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  types?: string[];
}

interface RawRow {
  company?: string;
  phone?: string;
  email?: string;
  city?: string;
  region?: string;
  country?: string;
  icp_segment?: string;
  tags?: string[];
  source_url?: string;
  email_source?: string;
  place_id?: string;
  raw_rating?: number;
  raw_rating_count?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function crawlForEmail(siteUrl: string): Promise<{ email: string; source: string } | null> {
  let base: string;
  try {
    const u = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
    base = `${u.protocol}//${u.host}`;
  } catch { return null; }

  for (const path of CONTACT_PATHS) {
    const url = base + path;
    const html = await fetchText(url);
    if (!html) continue;
    const email = pickBestEmail(extractEmails(html), base);
    if (email) return { email, source: url };
  }
  return null;
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
  return [...out].filter((e) => !isJunk(e));
}

function isJunk(email: string): boolean {
  const [local, domain] = email.split('@');
  if (!local || !domain) return true;
  if (JUNK_LOCAL.has(local)) return true;
  if (JUNK_DOMAINS.has(domain)) return true;
  if (/\.(png|jpg|gif|css|js)$/i.test(domain)) return true;
  return false;
}

function pickBestEmail(emails: string[], siteBase: string): string | undefined {
  if (!emails.length) return undefined;
  let host = '';
  try { host = new URL(siteBase).hostname.replace(/^www\./, ''); } catch { /**/ }
  const onDomain = emails.filter((e) => e.endsWith(`@${host}`) || e.endsWith(`@${host.split('.').slice(-2).join('.')}`));
  const pool = onDomain.length ? onDomain : emails;
  for (const p of ['info', 'hello', 'contact', 'bookings', 'appointments']) {
    const hit = pool.find((e) => e.startsWith(`${p}@`));
    if (hit) return hit;
  }
  return pool[0];
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'OneClickitLeadsBot/1.0 (+https://oneclickitleads.com)', Accept: 'text/html' },
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('html') && !ct.includes('text')) return null;
    return (await resp.text()).slice(0, 300_000);
  } catch { return null; }
}

function componentOf(comps: PlaceResult['addressComponents'], types: string[]) {
  return comps?.find((c) => c.types?.some((t) => types.includes(t)))?.longText;
}

function componentShort(comps: PlaceResult['addressComponents'], types: string[]) {
  const c = comps?.find((c) => c.types?.some((t) => types.includes(t)));
  return c?.shortText ?? c?.longText;
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
