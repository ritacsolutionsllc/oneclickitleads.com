import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch } from '@/utils/scrub/pipeline';

/**
 * GET /api/places-salons?query=salon+Los+Angeles,CA&client=chella
 *
 * Pulls salon businesses from Google Places (Text Search), paginates up to 60
 * results (3 pages x 20), dedupes by phone/address, and ingests into leads.
 *
 * This is the primary B2B scraper for Chella (vegan beauty → brow/lash salons).
 *
 * Cost control: field mask keeps calls at the cheap tier
 * (~$17/1k after $200 free credit).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query') || 'eyebrow salon Los Angeles CA';
  const clientSlug = searchParams.get('client') || 'chella';
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return NextResponse.json({ error: 'missing GOOGLE_PLACES_KEY' }, { status: 500 });

  const results: GooglePlace[] = [];
  let pageToken: string | null = null;
  let guard = 0;
  do {
    const params = new URLSearchParams({
      query,
      key,
      fields:
        'business_status,name,formatted_address,formatted_phone_number,website,rating,user_ratings_total',
    });
    if (pageToken) params.append('pagetoken', pageToken);

    const r = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`
    );
    const data = (await r.json()) as {
      status: string;
      results: GooglePlace[];
      next_page_token?: string;
    };
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return NextResponse.json({ error: data.status }, { status: 400 });
    }
    results.push(...(data.results ?? []));
    pageToken = data.next_page_token ?? null;
    if (pageToken) await new Promise((r) => setTimeout(r, 2000)); // Google requires a short delay
    guard++;
  } while (pageToken && guard < 3);

  // Turn Places results into raw leads (phone-only; emails enriched later via Hunter).
  const rows = results
    .filter((p) => p.business_status === 'OPERATIONAL')
    .map((p) => ({
      company: p.name,
      phone: p.formatted_phone_number,
      // We don't have emails yet — enrichment layer will try Hunter on the domain from website.
      email: undefined,
      title: 'Owner / Manager',
      icp_segment: 'salon',
      city: extractCity(p.formatted_address),
      region: extractRegion(p.formatted_address),
      country: 'US',
      tags: ['google_places', 'salon'],
      source_url: p.website ?? undefined,
      raw_rating: p.rating,
      raw_rating_count: p.user_ratings_total,
    }));

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', clientSlug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const { data: src } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: 'scraped',
      label: `google_places: ${query}`,
      source_url: 'https://maps.googleapis.com/maps/api/place/textsearch/json',
    })
    .select('id').single();

  const scrubbed = await scrubBatch(supabase as never, client.id, rows);

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
  }));

  const { error } = await supabase.from('leads').insert(toInsert);

  return NextResponse.json({
    query,
    fetched: results.length,
    ingested: toInsert.length,
    clean: toInsert.filter((r) => r.is_scrubbed).length,
    error: error?.message,
  });
}

interface GooglePlace {
  business_status?: string;
  name: string;
  formatted_address?: string;
  formatted_phone_number?: string;
  website?: string;
  rating?: number;
  user_ratings_total?: number;
}

function extractCity(addr?: string) {
  if (!addr) return undefined;
  const parts = addr.split(',').map((s) => s.trim());
  return parts.length >= 3 ? parts[parts.length - 3] : undefined;
}

function extractRegion(addr?: string) {
  if (!addr) return undefined;
  const parts = addr.split(',').map((s) => s.trim());
  // "Los Angeles, CA 90001, USA" → region = "CA"
  const penultimate = parts[parts.length - 2];
  return penultimate?.split(' ')[0];
}
