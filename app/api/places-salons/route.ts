import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch } from '@/utils/scrub/pipeline';
import { toLeadRow } from '@/utils/scrub/persist';
import { sourceTierFor } from '@/utils/scoring/score';

/**
 * GET /api/places-salons?query=eyebrow+salon+Los+Angeles+CA&client=chella&segment=salon
 *
 * Pulls businesses from Google Places API (New) Text Search. Uses a single
 * POST with a FieldMask so we get phone, website, address components, types
 * and opening hours in one round-trip (the legacy Text Search endpoint did
 * NOT return phone/website, which silently broke the scraper).
 *
 * Paginates up to 3 pages (60 results). Dedupes by Google place_id and
 * feeds rows through the scrub pipeline.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query') || 'eyebrow salon Los Angeles CA';
  const clientSlug = searchParams.get('client') || 'chella';
  const segment = searchParams.get('segment') || 'salon';
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return NextResponse.json({ error: 'missing GOOGLE_PLACES_KEY' }, { status: 500 });

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.addressComponents',
    'places.nationalPhoneNumber',
    'places.internationalPhoneNumber',
    'places.websiteUri',
    'places.rating',
    'places.userRatingCount',
    'places.businessStatus',
    'places.types',
    'places.primaryType',
    'places.regularOpeningHours',
    'nextPageToken',
  ].join(',');

  const results: PlaceV1[] = [];
  let pageToken: string | undefined;
  let guard = 0;
  do {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({
        textQuery: query,
        pageSize: 20,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return NextResponse.json(
        { error: `places v1: HTTP ${resp.status}`, detail: body.slice(0, 500) },
        { status: 502 }
      );
    }
    const data = (await resp.json()) as { places?: PlaceV1[]; nextPageToken?: string };
    results.push(...(data.places ?? []));
    pageToken = data.nextPageToken;
    if (pageToken) await new Promise((r) => setTimeout(r, 2000));
    guard++;
  } while (pageToken && guard < 3);

  const rows = results
    .filter((p) => p.businessStatus === 'OPERATIONAL')
    .map((p) => {
      const city = componentOf(p.addressComponents, ['locality', 'postal_town']);
      const region = componentShortOf(p.addressComponents, [
        'administrative_area_level_1',
      ]);
      const country = componentShortOf(p.addressComponents, ['country']) ?? 'US';
      return {
        company: p.displayName?.text,
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber,
        email: undefined,
        title: 'Owner / Manager',
        icp_segment: segment,
        city,
        region,
        country,
        tags: ['google_places', segment, ...(p.types ?? [])].slice(0, 10),
        source_url: p.websiteUri,
        place_id: p.id,
        primary_type: p.primaryType,
        opening_hours: p.regularOpeningHours?.weekdayDescriptions,
        raw_rating: p.rating,
        raw_rating_count: p.userRatingCount,
      };
    });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', clientSlug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const { data: src } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: 'places',
      tier: sourceTierFor('places'),
      label: `google_places: ${query}`,
      source_url: 'https://places.googleapis.com/v1/places:searchText',
    })
    .select('id').single();

  // Preserve Google Places signals so the scoring engine can see rating
  // and review volume. These get persisted onto the lead row too.
  const rowsForScoring = rows.map((r) => ({
    ...r,
    rating: r.raw_rating,
    rating_count: r.raw_rating_count,
  }));
  const scrubbed = await scrubBatch(supabase as never, client.id, rowsForScoring, {
    source_kind: 'places',
  });

  const toInsert = scrubbed.map((s) =>
    toLeadRow(s, { client_id: client.id, source_id: src?.id })
  );

  const { error } = await supabase.from('leads').insert(toInsert);

  return NextResponse.json({
    query,
    fetched: results.length,
    with_phone: rows.filter((r) => r.phone).length,
    with_website: rows.filter((r) => r.source_url).length,
    ingested: toInsert.length,
    clean: toInsert.filter((r) => r.is_scrubbed).length,
    export_eligible: toInsert.filter((r) => r.export_eligible).length,
    quarantined: toInsert.filter((r) => r.review_state === 'quarantined').length,
    error: error?.message,
  });
}

interface AddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface PlaceV1 {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  types?: string[];
  primaryType?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
}

function componentOf(comps: AddressComponent[] | undefined, wantedTypes: string[]) {
  for (const c of comps ?? []) {
    if (c.types?.some((t) => wantedTypes.includes(t))) return c.longText;
  }
  return undefined;
}

function componentShortOf(comps: AddressComponent[] | undefined, wantedTypes: string[]) {
  for (const c of comps ?? []) {
    if (c.types?.some((t) => wantedTypes.includes(t))) return c.shortText ?? c.longText;
  }
  return undefined;
}
