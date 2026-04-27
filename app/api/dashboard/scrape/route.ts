import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createClient } from '@/utils/supabase/server';
import { scrubBatch } from '@/utils/scrub/pipeline';

type ScrapeSource = 'places' | 'harvest' | 'enrich' | 'rescrub';

const VALID_SOURCES: ScrapeSource[] = ['places', 'harvest', 'enrich', 'rescrub'];

const VALID_SEGMENTS = new Set([
  'salon',
  'b2c_beauty',
  'influencer',
  'retailer',
  'medspa',
  'wellness',
  'fitness',
  'healthcare',
  'pharmacy',
  'retail',
  'ecommerce',
  'restaurant',
  'food_truck',
  'hospitality',
  'real_estate',
  'professional_services',
  'marketing_agency',
  'home_services',
  'automotive',
  'education',
  'tech',
  'nonprofit',
]);

const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_RX = /mailto:([^"'?\s>]+)/gi;
const CONTACT_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us'];

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json()) as Record<string, unknown>;
  const source = String(body.source ?? '') as ScrapeSource;
  const clientSlug = String(body.client_slug ?? '').trim();

  if (!VALID_SOURCES.includes(source)) {
    return NextResponse.json({ error: `source must be one of ${VALID_SOURCES.join(', ')}` }, { status: 400 });
  }
  if (!clientSlug) return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  const admin = createAdminClient();
  const { data: client } = await admin
    .from('clients')
    .select('id, owner_user')
    .eq('slug', clientSlug)
    .single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });
  if (client.owner_user !== user.id) return NextResponse.json({ error: 'not your client' }, { status: 403 });

  if (source === 'places') return runPlaces(admin, client.id, body);
  if (source === 'harvest') return runHarvest(admin, client.id, body);
  if (source === 'enrich') return runEnrich(admin, client.id, body);
  return runRescrub(admin, client.id, body);
}

async function runPlaces(admin: ReturnType<typeof createAdminClient>, clientId: string, body: Record<string, unknown>) {
  const key = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_PLACES_KEY;
  if (!key) return NextResponse.json({ error: 'GOOGLE_PLACES_API_KEY missing' }, { status: 500 });

  const query = String(body.query ?? '').trim().slice(0, 200);
  if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 });

  const segmentCandidate = String(body.segment ?? 'salon');
  const segment = VALID_SEGMENTS.has(segmentCandidate) ? segmentCandidate : 'salon';

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.addressComponents',
    'places.nationalPhoneNumber',
    'places.websiteUri',
    'places.rating',
    'places.userRatingCount',
    'places.businessStatus',
    'places.types',
    'nextPageToken',
  ].join(',');

  const places: PlaceResult[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;

  do {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({ textQuery: query, pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      return NextResponse.json({ error: `Places API failed (${resp.status})`, detail: detail.slice(0, 500) }, { status: 502 });
    }

    const payload = (await resp.json()) as { places?: PlaceResult[]; nextPageToken?: string };
    places.push(...(payload.places ?? []).filter((p) => p.businessStatus === 'OPERATIONAL'));
    pageToken = payload.nextPageToken;
    pageCount += 1;
    if (pageToken) await delay(2_000);
  } while (pageToken && pageCount < 3);

  const rows = places.map((p) => ({
    company: p.displayName?.text,
    phone: p.nationalPhoneNumber ?? undefined,
    email: undefined as string | undefined,
    city: componentOf(p.addressComponents, ['locality', 'postal_town']),
    region: componentShortOf(p.addressComponents, ['administrative_area_level_1']),
    country: componentShortOf(p.addressComponents, ['country']) ?? 'US',
    icp_segment: segment,
    tags: ['google_places', segment, ...(p.types ?? [])].slice(0, 10),
    source_url: p.websiteUri ?? undefined,
    place_id: p.id,
    raw_rating: p.rating,
    raw_rating_count: p.userRatingCount,
  }));

  const { data: sourceRow } = await admin
    .from('sources')
    .insert({
      client_id: clientId,
      kind: 'scraped',
      label: `places: ${query}`,
      source_url: 'https://places.googleapis.com/v1/places:searchText',
    })
    .select('id')
    .single();

  const scrubbed = await scrubBatch(admin as never, clientId, rows, { doEnrich: false });

  const inserts = scrubbed.map((s, i) => ({
    client_id: clientId,
    source_id: sourceRow?.id ?? null,
    company: s.company ?? null,
    email: s.normalized_email || null,
    phone_e164: s.phone_e164,
    city: s.city ?? null,
    region: s.region ?? null,
    country: s.country ?? null,
    icp_segment: s.icp_segment ?? null,
    tags: (s.tags as string[]) ?? [],
    is_scrubbed: s.is_scrubbed,
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    is_disposable: s.is_disposable,
    is_duplicate: s.is_duplicate,
    is_suppressed: s.is_suppressed,
    scrub_score: s.scrub_score,
    reject_reason: s.reject_reason ?? null,
    rating: rows[i].raw_rating ?? null,
    rating_count: rows[i].raw_rating_count ?? null,
    website: rows[i].source_url ?? null,
    raw: rows[i],
    scrubbed_at: new Date().toISOString(),
  }));

  const { error } = await admin.from('leads').insert(inserts);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    source: 'places',
    fetched: places.length,
    inserted: inserts.length,
    clean: inserts.filter((r) => r.is_scrubbed).length,
  });
}

async function runHarvest(admin: ReturnType<typeof createAdminClient>, clientId: string, body: Record<string, unknown>) {
  const limit = Math.min(200, Math.max(1, Number(body.limit ?? 50)));

  const { data: leads, error } = await admin
    .from('leads')
    .select('id, website, raw')
    .eq('client_id', clientId)
    .is('email', null)
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let checked = 0;
  let updated = 0;

  for (const lead of leads ?? []) {
    const raw = lead.raw as { source_url?: string } | null;
    const site = lead.website ?? raw?.source_url;
    if (!site) continue;
    checked += 1;
    const email = await crawlForEmail(site);
    if (!email) continue;
    updated += 1;
    await admin
      .from('leads')
      .update({
        email,
        syntax_valid: true,
        reject_reason: null,
        raw: { ...(raw ?? {}), harvested_from: site },
      })
      .eq('id', lead.id);
  }

  return NextResponse.json({ source: 'harvest', checked, updated });
}

async function runEnrich(admin: ReturnType<typeof createAdminClient>, clientId: string, body: Record<string, unknown>) {
  const hunter = process.env.HUNTER_API_KEY;
  if (!hunter) return NextResponse.json({ error: 'HUNTER_API_KEY missing' }, { status: 500 });

  const batchSize = Math.min(200, Math.max(1, Number(body.batch_size ?? 100)));
  const { data: targets, error } = await admin
    .from('leads')
    .select('id, website, raw')
    .eq('client_id', clientId)
    .is('email', null)
    .limit(batchSize);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let processed = 0;
  let enriched = 0;

  for (const t of targets ?? []) {
    const raw = t.raw as { source_url?: string } | null;
    const site = t.website ?? raw?.source_url;
    if (!site) continue;
    processed += 1;

    let domain: string | null = null;
    try {
      domain = new URL(site.startsWith('http') ? site : `https://${site}`).hostname.replace(/^www\./, '');
    } catch {
      domain = null;
    }
    if (!domain) continue;

    try {
      const resp = await fetch(
        `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunter}&limit=1`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!resp.ok) continue;
      const payload = (await resp.json()) as { data?: { emails?: { value?: string; confidence?: number }[] } };
      const candidate = payload.data?.emails?.[0];
      if (!candidate?.value || (candidate.confidence ?? 0) < 70) continue;

      enriched += 1;
      await admin
        .from('leads')
        .update({ email: candidate.value, syntax_valid: true, reject_reason: null, website: site })
        .eq('id', t.id);
    } catch {
      // swallow per-lead failures
    }

    await delay(250);
  }

  return NextResponse.json({ source: 'enrich', processed, enriched });
}

async function runRescrub(admin: ReturnType<typeof createAdminClient>, clientId: string, body: Record<string, unknown>) {
  const limit = Math.min(500, Math.max(1, Number(body.limit ?? 100)));
  const { data: pending, error } = await admin
    .from('leads')
    .select('id, email, phone_e164, first_name, last_name, company, title, city, region, country, icp_segment, tags, website, raw')
    .eq('client_id', clientId)
    .not('email', 'is', null)
    .or('is_scrubbed.is.false,is_scrubbed.is.null')
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!pending?.length) return NextResponse.json({ source: 'rescrub', processed: 0, clean: 0, rejected: 0 });

  const rows = pending.map((l) => ({
    email: l.email ?? undefined,
    phone: l.phone_e164 ?? undefined,
    first_name: l.first_name ?? undefined,
    last_name: l.last_name ?? undefined,
    company: l.company ?? undefined,
    title: l.title ?? undefined,
    city: l.city ?? undefined,
    region: l.region ?? undefined,
    country: l.country ?? undefined,
    icp_segment: l.icp_segment ?? undefined,
    tags: (l.tags as string[] | null) ?? undefined,
    source_url: l.website ?? (l.raw as { source_url?: string } | null)?.source_url ?? undefined,
  }));

  const scrubbed = await scrubBatch(admin as never, clientId, rows, { doEnrich: true });

  for (let i = 0; i < scrubbed.length; i += 1) {
    const s = scrubbed[i];
    const row = rows[i];
    const lead = pending[i];
    await admin
      .from('leads')
      .update({
        email: s.normalized_email || null,
        phone_e164: s.phone_e164,
        first_name: s.first_name ?? null,
        last_name: s.last_name ?? null,
        company: s.company ?? null,
        title: s.title ?? null,
        city: s.city ?? null,
        region: s.region ?? null,
        country: s.country ?? null,
        icp_segment: s.icp_segment ?? null,
        tags: (s.tags as string[]) ?? [],
        is_scrubbed: s.is_scrubbed,
        syntax_valid: s.syntax_valid,
        mx_valid: s.mx_valid,
        smtp_valid: s.smtp_valid,
        is_disposable: s.is_disposable,
        is_duplicate: s.is_duplicate,
        is_suppressed: s.is_suppressed,
        scrub_score: s.scrub_score,
        reject_reason: s.reject_reason ?? null,
        website: row.source_url ?? null,
        raw: { ...((lead.raw as Record<string, unknown>) ?? {}), ...s },
        scrubbed_at: new Date().toISOString(),
      })
      .eq('id', lead.id);
  }

  return NextResponse.json({
    source: 'rescrub',
    processed: scrubbed.length,
    clean: scrubbed.filter((s) => s.is_scrubbed).length,
    rejected: scrubbed.filter((s) => !s.is_scrubbed).length,
  });
}

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

function componentOf(comps: PlaceResult['addressComponents'], wantedTypes: string[]) {
  for (const c of comps ?? []) {
    if (c.types?.some((t) => wantedTypes.includes(t))) return c.longText;
  }
  return undefined;
}

function componentShortOf(comps: PlaceResult['addressComponents'], wantedTypes: string[]) {
  for (const c of comps ?? []) {
    if (c.types?.some((t) => wantedTypes.includes(t))) return c.shortText ?? c.longText;
  }
  return undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function crawlForEmail(siteUrl: string): Promise<string | null> {
  const base = normalizeSite(siteUrl);
  if (!base) return null;

  for (const path of CONTACT_PATHS) {
    const html = await fetchText(`${base}${path}`);
    if (!html) continue;
    const emails = extractEmails(html);
    if (emails.length > 0) return emails[0];
  }
  return null;
}

function normalizeSite(siteUrl: string): string | null {
  try {
    const parsed = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'OneClickitLeadsBot/1.0 (+https://oneclickitleads.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('html') && !ct.includes('text')) return null;
    return (await resp.text()).slice(0, 300_000);
  } catch {
    return null;
  }
}

function extractEmails(html: string): string[] {
  const decoded = html.replace(/&#64;|&#x40;/gi, '@').replace(/&#46;|&#x2e;/gi, '.').replace(/&amp;/g, '&');
  const found = new Set<string>();

  for (const match of decoded.matchAll(MAILTO_RX)) {
    const raw = decodeURIComponent(match[1].split('?')[0]).trim().toLowerCase();
    if (EMAIL_RX.test(raw)) found.add(raw);
    EMAIL_RX.lastIndex = 0;
  }
  for (const match of decoded.matchAll(EMAIL_RX)) {
    found.add(match[0].toLowerCase().replace(/\.$/, ''));
  }

  return [...found];
}
