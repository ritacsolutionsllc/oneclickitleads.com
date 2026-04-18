import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch } from '@/utils/scrub/pipeline';

/**
 * GET /api/scrape-osm?shop=beauty&city=Los+Angeles&region=CA&country=US&client=chella&segment=salon
 *
 * Free supplementary scraper backed by OpenStreetMap via the Overpass API.
 * No key required. Finds every tagged business of a given shop/amenity/craft
 * type inside a named administrative area, and captures emails/phones/websites
 * that OSM contributors have filled in — which is a surprising amount of
 * long-tail SMB data Google Places doesn't surface.
 *
 * Useful `shop` values for Chella's ICP: beauty, hairdresser, cosmetics.
 * Also accepts amenity/craft via ?type=amenity&kind=clinic etc.
 */
const OSM_KEYS = ['shop', 'amenity', 'craft'] as const;
type OsmKey = (typeof OSM_KEYS)[number];
function isOsmKey(v: string): v is OsmKey {
  return (OSM_KEYS as readonly string[]).includes(v);
}

// Overpass QL strings are quoted with ". Allow letters, numbers, spaces, and a
// handful of punctuation that shows up in real place/shop names. Anything else
// (especially ", \, ], ;) could break out of the query context.
const SAFE_TEXT = /^[A-Za-z0-9 \-_.'&:/]+$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientSlug = searchParams.get('client') || 'chella';
  const segment = searchParams.get('segment') || 'salon';
  const shop = searchParams.get('shop') || 'beauty';
  const city = searchParams.get('city') || 'Los Angeles';
  const region = searchParams.get('region') || 'CA';
  const country = searchParams.get('country') || 'US';
  const rawKey = searchParams.get('type') || 'shop';

  if (!isOsmKey(rawKey)) {
    return NextResponse.json(
      { error: `invalid type: must be one of ${OSM_KEYS.join(', ')}` },
      { status: 400 }
    );
  }
  if (!SAFE_TEXT.test(city) || city.length > 80) {
    return NextResponse.json({ error: 'invalid city' }, { status: 400 });
  }
  if (!SAFE_TEXT.test(shop) || shop.length > 40) {
    return NextResponse.json({ error: 'invalid shop' }, { status: 400 });
  }
  const osmKey: OsmKey = rawKey;

  const areaQuery = `area["name"="${city}"]["admin_level"~"6|7|8"]->.a;`;
  const query = `
    [out:json][timeout:60];
    ${areaQuery}
    (
      node["${osmKey}"="${shop}"](area.a);
      way["${osmKey}"="${shop}"](area.a);
      relation["${osmKey}"="${shop}"](area.a);
    );
    out tags center 500;
  `.trim();

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'OneClickitLeads/1.0 (https://oneclickitleads.com)',
    },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!resp.ok) {
    const body = await resp.text();
    return NextResponse.json(
      { error: `overpass: HTTP ${resp.status}`, detail: body.slice(0, 500) },
      { status: 502 }
    );
  }
  const data = (await resp.json()) as { elements?: OsmElement[] };
  const elements = data.elements ?? [];

  const rows = elements
    .map((e) => {
      const t = e.tags ?? {};
      const name = t.name || t['name:en'] || t['brand'];
      if (!name) return null;
      const email = firstNonEmpty(t.email, t['contact:email']);
      const phone = firstNonEmpty(t.phone, t['contact:phone']);
      const website = firstNonEmpty(t.website, t['contact:website'], t.url);
      return {
        company: name,
        email,
        phone,
        title: 'Owner / Manager',
        icp_segment: segment,
        city: firstNonEmpty(t['addr:city'], city),
        region: firstNonEmpty(t['addr:state'], region),
        country: firstNonEmpty(t['addr:country'], country),
        tags: ['osm', `osm:${osmKey}=${shop}`, segment].slice(0, 10),
        source_url: website,
        osm_type: e.type,
        osm_id: e.id,
        instagram: firstNonEmpty(t['contact:instagram'], t['brand:wikidata']),
        facebook: t['contact:facebook'],
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', clientSlug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const { data: src } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: 'scraped',
      label: `osm: ${osmKey}=${shop} in ${city}, ${region}`,
      source_url: 'https://overpass-api.de/api/interpreter',
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
    query: `${osmKey}=${shop} in ${city}`,
    fetched: elements.length,
    with_email: rows.filter((r) => r.email).length,
    with_phone: rows.filter((r) => r.phone).length,
    with_website: rows.filter((r) => r.source_url).length,
    ingested: toInsert.length,
    clean: toInsert.filter((r) => r.is_scrubbed).length,
    error: error?.message,
  });
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
}

function firstNonEmpty(...vals: (string | undefined | null)[]): string | undefined {
  for (const v of vals) if (v && v.trim()) return v.trim();
  return undefined;
}
