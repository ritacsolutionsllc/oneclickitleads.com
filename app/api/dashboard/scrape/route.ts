import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import { scrubBatch, scoringInsertFields } from '@/utils/scrub/pipeline';

/**
 * POST /api/dashboard/scrape
 * Browser-facing scraper endpoint — authenticated by Supabase session cookie.
 *
 * Body: { source, client_slug, ...source-specific fields }
 *
 * sources:
 *   places  — { query, segment?, limit? }  Google Places text search + scrub
 *   harvest — { limit? }                   Crawl existing lead websites for emails
 *   enrich  — { batch_size? }              Hunter.io domain-search enrichment
 *   rescrub — { limit? }                   Re-run scrub pipeline on pending leads
 */

const VALID_SOURCES = ['places', 'harvest', 'enrich', 'rescrub'] as const;

const ALL_SEGMENTS = new Set([
  'salon', 'b2c_beauty', 'influencer', 'retailer',
  'medspa', 'wellness', 'fitness', 'healthcare', 'pharmacy',
  'retail', 'ecommerce',
  'restaurant', 'food_truck', 'hospitality',
  'real_estate', 'professional_services', 'marketing_agency',
  'home_services', 'automotive',
  'education', 'tech', 'nonprofit',
]);

// Email extraction helpers
const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_RX = /mailto:([^"'?\s>]+)/gi;
const JUNK_DOMAINS = new Set([
  'sentry.io', 'wix.com', 'squarespace.com', 'example.com',
  'godaddy.com', 'yourdomain.com', 'domain.com',
]);
const JUNK_LOCAL = new Set(['noreply', 'no-reply', 'donotreply', 'postmaster', 'mailer-daemon']);
const CONTACT_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/team'];

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const source = String(body.source ?? '');
  const clientSlug = String(body.client_slug ?? '').slice(0, 64);

  if (!VALID_SOURCES.includes(source as typeof VALID_SOURCES[number])) {
    return NextResponse.json({ error: `source must be one of ${VALID_SOURCES.join(', ')}` }, { status: 400 });
  }
  if (!clientSlug) return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  // Verify user owns this client
  const { data: client } = await supabase
    .from('clients').select('id, slug, name, plan').eq('slug', clientSlug).eq('owner_user', user.id).single();
  if (!client) return NextResponse.json({ error: 'client not found' }, { status: 404 });

  const admin = createAdminClient();

  // ── Places ─────────────────────────────────────────────────────────────────
  if (source === 'places') {
    const placesKey = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_PLACES_KEY;
    if (!placesKey) return NextResponse.json({ error: 'GOOGLE_PLACES_API_KEY not configured in Vercel' }, { status: 500 });

    const query = String(body.query ?? '').slice(0, 200).trim();
    if (!query) return NextResponse.json({ error: 'query is required' }, { status: 400 });
    const segment = ALL_SEGMENTS.has(String(body.segment)) ? String(body.segment) : 'salon';

    const fieldMask = [
      'places.id', 'places.displayName', 'places.addressComponents',
      'places.nationalPhoneNumber', 'places.websiteUri',
      'places.rating', 'places.userRatingCount', 'places.businessStatus',
      'places.types', 'nextPageToken',
    ].join(',');

    const placeResults: PlaceResult[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': placesKey,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify({ textQuery: query, pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
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
    } while (pageToken && pages < 3);

    const rows = placeResults.map((p) => ({
      company: p.displayName?.text,
      phone: p.nationalPhoneNumber ?? undefined,
      email: undefined as string | undefined,
      city: componentOf(p.addressComponents, ['locality', 'postal_town']),
      region: componentShort(p.addressComponents, ['administrative_area_level_1']),
      country: componentShort(p.addressComponents, ['country']) ?? 'US',
      icp_segment: segment,
      tags: ['google_places', segment, ...(p.types ?? [])].slice(0, 10),
      source_url: p.websiteUri ?? undefined,
      place_id: p.id,
      raw_rating: p.rating,
      raw_rating_count: p.userRatingCount,
    }));

    const { data: src } = await admin.from('sources').insert({
      client_id: client.id, kind: 'scraped',
      label: `places: ${query}`,
      source_url: 'https://places.googleapis.com',
    }).select('id').single();

    const scrubbed = await scrubBatch(admin as never, client.id, rows);

    const toUpsert = scrubbed.map((s, i) => ({
      client_id: client.id,
      source_id: src?.id ?? null,
      company: s.company ?? null,
      phone_e164: s.phone_e164,
      email: s.normalized_email || null,
      icp_segment: s.icp_segment ?? null,
      city: s.city ?? null, region: s.region ?? null, country: s.country ?? null,
      tags: (s.tags as string[]) ?? [],
      is_scrubbed: s.is_scrubbed, is_duplicate: s.is_duplicate,
      syntax_valid: s.syntax_valid, mx_valid: s.mx_valid, smtp_valid: s.smtp_valid,
      is_disposable: s.is_disposable, scrub_score: s.scrub_score,
      reject_reason: s.reject_reason ?? null,
      raw: { ...rows[i], ...s },
      scrubbed_at: new Date().toISOString(),
      ...scoringInsertFields(s),
    }));

    await admin.from('leads').upsert(toUpsert, { onConflict: 'client_id,email_hash', ignoreDuplicates: true });

    return NextResponse.json({
      source: 'places',
      query,
      fetched: placeResults.length,
      inserted: toUpsert.length,
      clean: scrubbed.filter((s) => s.is_scrubbed).length,
      with_phone: rows.filter((r) => r.phone).length,
      with_email: rows.filter((r) => r.email).length,
    });
  }

  // ── Harvest emails ─────────────────────────────────────────────────────────
  if (source === 'harvest') {
    const limit = Math.min(200, Math.max(1, Number(body.limit ?? 50)));

    const { data: leadsRaw } = await admin
      .from('leads').select('id, company, raw')
      .eq('client_id', client.id).is('email', null)
      .not('raw->>source_url', 'is', null).limit(limit);

    type HarvestRow = { id: string; company: string | null; raw: Record<string, unknown> | null };
    const harvestLeads = (leadsRaw ?? []) as HarvestRow[];

    let updated = 0;
    const checked = harvestLeads.length;

    await Promise.all(
      chunkArray(harvestLeads, 4).flatMap((chunk) =>
        chunk.map(async (lead) => {
          const site = (lead.raw as { source_url?: string } | null)?.source_url;
          if (!site) return;
          const email = await crawlForEmail(site);
          if (email) {
            updated++;
            await admin.from('leads').update({ email, syntax_valid: true, reject_reason: null }).eq('id', lead.id);
          }
        })
      )
    );

    return NextResponse.json({ source: 'harvest', checked, updated });
  }

  // ── Enrich via Hunter ──────────────────────────────────────────────────────
  if (source === 'enrich') {
    const hunterKey = process.env.HUNTER_API_KEY;
    if (!hunterKey) return NextResponse.json({ error: 'HUNTER_API_KEY not configured in Vercel' }, { status: 500 });

    const batchSize = Math.min(200, Math.max(1, Number(body.batch_size ?? 100)));

    const { data: targets } = await admin
      .from('leads').select('id, raw')
      .eq('client_id', client.id).is('email', null)
      .not('raw->>source_url', 'is', null).limit(batchSize);

    let enriched = 0;
    for (const t of targets ?? []) {
      const url = (t.raw as { source_url?: string } | null)?.source_url;
      if (!url) continue;
      try {
        const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
        const r = await fetch(
          `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=1`,
          { signal: AbortSignal.timeout(8_000) }
        );
        if (!r.ok) continue;
        const data = await r.json() as { data?: { emails?: { value?: string }[] } };
        const email = data.data?.emails?.[0]?.value;
        if (email) {
          enriched++;
          await admin.from('leads').update({ email, syntax_valid: true }).eq('id', t.id);
        }
      } catch { /**/ }
      await delay(300); // Hunter rate limit
    }

    return NextResponse.json({ source: 'enrich', processed: targets?.length ?? 0, enriched });
  }

  // ── Rescrub ────────────────────────────────────────────────────────────────
  if (source === 'rescrub') {
    const limit = Math.min(500, Math.max(1, Number(body.limit ?? 100)));

    const { data: pendingRaw } = await admin
      .from('leads').select('id, email, phone_e164, company, city, region, country, icp_segment, tags, raw')
      .eq('client_id', client.id).not('email', 'is', null)
      .or('is_scrubbed.is.null,is_scrubbed.eq.false').limit(limit);

    if (!pendingRaw?.length) return NextResponse.json({ source: 'rescrub', processed: 0, clean: 0 });

    type PendingRow = {
      id: string; email: string | null; phone_e164: string | null; company: string | null;
      city: string | null; region: string | null; country: string | null;
      icp_segment: string | null; tags: string[] | null; raw: Record<string, unknown> | null;
    };
    const pending = pendingRaw as PendingRow[];

    const rows = pending.map((l) => ({
      email: l.email ?? undefined,
      phone: l.phone_e164 ?? undefined,
      company: l.company ?? undefined,
      city: l.city ?? undefined,
      region: l.region ?? undefined,
      country: l.country ?? undefined,
      icp_segment: l.icp_segment ?? undefined,
      tags: (l.tags as string[] | null) ?? undefined,
      ...((l.raw as Record<string, unknown>) ?? {}),
    }));

    const scrubbed = await scrubBatch(admin as never, client.id, rows);

    await Promise.all(
      scrubbed.map((s, i) =>
        admin.from('leads').update({
          is_scrubbed: s.is_scrubbed, is_duplicate: s.is_duplicate,
          syntax_valid: s.syntax_valid, mx_valid: s.mx_valid, smtp_valid: s.smtp_valid,
          is_disposable: s.is_disposable, scrub_score: s.scrub_score,
          reject_reason: s.reject_reason ?? null,
          scrubbed_at: new Date().toISOString(),
          ...scoringInsertFields(s),
        }).eq('id', pending[i].id)
      )
    );

    return NextResponse.json({
      source: 'rescrub',
      processed: scrubbed.length,
      clean: scrubbed.filter((s) => s.is_scrubbed).length,
      rejected: scrubbed.filter((s) => !s.is_scrubbed).length,
    });
  }

  return NextResponse.json({ error: 'unhandled source' }, { status: 400 });
}

// ── Types ────────────────────────────────────────────────────────────────────
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

// ── Email harvest helpers ─────────────────────────────────────────────────────
async function crawlForEmail(siteUrl: string): Promise<string | null> {
  let base: string;
  try {
    const u = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
    base = `${u.protocol}//${u.host}`;
  } catch { return null; }

  for (const path of CONTACT_PATHS) {
    const html = await fetchText(base + path);
    if (!html) continue;
    const email = pickBestEmail(extractEmails(html), base);
    if (email) return email;
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
  for (const p of ['info', 'hello', 'contact', 'bookings', 'appointments', 'sales']) {
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

// ── Misc helpers ──────────────────────────────────────────────────────────────
function componentOf(comps: PlaceResult['addressComponents'], types: string[]) {
  return comps?.find((c) => c.types?.some((t) => types.includes(t)))?.longText;
}
function componentShort(comps: PlaceResult['addressComponents'], types: string[]) {
  const c = comps?.find((c) => c.types?.some((t) => types.includes(t)));
  return c?.shortText ?? c?.longText;
}
function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
