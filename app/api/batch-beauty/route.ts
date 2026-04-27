import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch, scoringInsertFields } from '@/utils/scrub/pipeline';

/**
 * POST /api/batch-beauty
 *
 * Broad multi-industry scraper that populates the shared inventory database.
 * Iterates top US cities × industry categories via Google Places and upserts
 * each result with is_inventory=true so starter/growth subscribers can browse
 * without running their own scrapes.
 *
 * Auth: x-ingest-secret header.
 * Designed for n8n / Vercel cron — call nightly.
 *
 * Body (all optional):
 *   cities?:      string[]  — defaults to TOP_US_CITIES
 *   categories?:  string[]  — defaults to ALL_CATEGORIES
 *   client_slug?: string    — client to credit leads to (defaults to 'inventory')
 *   max_per_city? number    — Places results per city per category (max 20, default 20)
 *   dry_run?:     boolean   — parse + fetch but skip DB writes
 */

// Top 50 US markets by population
const TOP_US_CITIES = [
  'New York NY', 'Los Angeles CA', 'Chicago IL', 'Houston TX', 'Phoenix AZ',
  'Philadelphia PA', 'San Antonio TX', 'San Diego CA', 'Dallas TX', 'San Jose CA',
  'Austin TX', 'Jacksonville FL', 'Fort Worth TX', 'Columbus OH', 'Charlotte NC',
  'Indianapolis IN', 'San Francisco CA', 'Seattle WA', 'Denver CO', 'Nashville TN',
  'Oklahoma City OK', 'El Paso TX', 'Washington DC', 'Boston MA', 'Las Vegas NV',
  'Portland OR', 'Memphis TN', 'Louisville KY', 'Baltimore MD', 'Milwaukee WI',
  'Albuquerque NM', 'Tucson AZ', 'Fresno CA', 'Sacramento CA', 'Mesa AZ',
  'Kansas City MO', 'Atlanta GA', 'Omaha NE', 'Colorado Springs CO', 'Raleigh NC',
  'Long Beach CA', 'Virginia Beach VA', 'Minneapolis MN', 'Tampa FL', 'New Orleans LA',
  'Arlington TX', 'Bakersfield CA', 'Honolulu HI', 'Anaheim CA', 'Aurora CO',
];

// All supported industry categories
const ALL_CATEGORIES = [
  // Beauty & Wellness
  'hair salon',
  'nail salon',
  'brow bar lash studio',
  'medspa medical spa',
  'skincare studio esthetician',
  'beauty supply store',
  'makeup artist studio',
  'massage spa wellness center',
  'tanning salon spray tan',
  'tattoo shop piercing studio',
  // Fitness & Health
  'gym fitness center',
  'yoga pilates studio',
  'personal training studio',
  'crossfit box functional fitness',
  'dental practice dentist',
  'chiropractic clinic',
  'therapist counseling mental health',
  // Retail
  'cosmetics beauty retailer',
  'boutique clothing store',
  'jewelry store boutique',
  // Food & Hospitality
  'restaurant dining',
  'cafe coffee shop',
  'bakery patisserie',
  'bar nightclub lounge',
  'hotel boutique bed breakfast',
  // Professional Services
  'real estate agent realtor',
  'law firm attorney',
  'accounting firm CPA',
  'marketing agency digital',
  'insurance agent broker',
  // Home & Auto
  'home contractor remodeling',
  'cleaning service maid',
  'landscaping lawn care',
  'auto dealer car dealership',
  'auto repair mechanic shop',
  // Education
  'tutoring center learning',
  'dance studio performing arts',
  'music school lessons',
];

const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.addressComponents',
  'places.nationalPhoneNumber', 'places.websiteUri',
  'places.rating', 'places.userRatingCount', 'places.businessStatus',
  'places.types', 'places.primaryType',
].join(',');

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!placesKey)
    return NextResponse.json({ error: 'GOOGLE_PLACES_API_KEY not set' }, { status: 500 });

  let body: {
    cities?: string[];
    categories?: string[];
    client_slug?: string;
    max_per_city?: number;
    dry_run?: boolean;
  } = {};
  try { body = await req.json(); } catch { /**/ }

  const cities = (body.cities?.length ? body.cities : TOP_US_CITIES).map((c) => String(c).slice(0, 100));
  const categories = (body.categories?.length ? body.categories : ALL_CATEGORIES).map((c) => String(c).slice(0, 100));
  const clientSlug = String(body.client_slug ?? 'inventory').slice(0, 64);
  const maxPerQuery = Math.min(20, Math.max(1, Number(body.max_per_city ?? 20)));
  const dryRun = body.dry_run === true;

  const supabase = createAdminClient();

  // Resolve client
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', clientSlug).single();
  if (!client)
    return NextResponse.json({ error: `client '${clientSlug}' not found` }, { status: 404 });

  const stats = { queries: 0, fetched: 0, inserted: 0, clean: 0, errors: 0 };
  const seen = new Set<string>(); // dedupe place_ids within this run

  for (const city of cities) {
    for (const category of categories) {
      const textQuery = `${category} ${city}`;
      stats.queries++;

      try {
        const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': placesKey,
            'X-Goog-FieldMask': FIELD_MASK,
          },
          body: JSON.stringify({ textQuery, pageSize: maxPerQuery }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!resp.ok) { stats.errors++; continue; }

        const data = await resp.json() as { places?: PlaceV1[] };
        const places = (data.places ?? []).filter(
          (p) => p.businessStatus === 'OPERATIONAL' && p.id && !seen.has(p.id)
        );
        for (const p of places) seen.add(p.id!);

        stats.fetched += places.length;
        if (!places.length || dryRun) continue;

        const rows = places.map((p) => ({
          company: p.displayName?.text,
          phone: p.nationalPhoneNumber ?? undefined,
          email: undefined as string | undefined,
          city: componentOf(p.addressComponents, ['locality', 'postal_town']),
          region: componentShort(p.addressComponents, ['administrative_area_level_1']),
          country: componentShort(p.addressComponents, ['country']) ?? 'US',
          icp_segment: categoryToSegment(category),
          tags: ['google_places', 'inventory', categoryToSegment(category), ...(p.types ?? [])].slice(0, 10),
          source_url: p.websiteUri ?? undefined,
          place_id: p.id,
          primary_type: p.primaryType,
          raw_rating: p.rating,
          raw_rating_count: p.userRatingCount,
        }));

        const scrubbed = await scrubBatch(supabase as never, client.id, rows, { doEnrich: false });

        const toUpsert = scrubbed.map((s, i) => ({
          client_id: client.id,
          company: s.company ?? null,
          phone_e164: s.phone_e164,
          email: s.normalized_email || null,
          icp_segment: s.icp_segment ?? null,
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
          is_inventory: true,
          raw: { ...rows[i], ...s },
          scrubbed_at: new Date().toISOString(),
          ...scoringInsertFields(s),
        }));

        const { error: upsertErr } = await supabase
          .from('leads')
          .upsert(toUpsert, { onConflict: 'client_id,email_hash', ignoreDuplicates: true });

        if (!upsertErr) {
          stats.inserted += toUpsert.length;
          stats.clean += scrubbed.filter((s) => s.is_scrubbed).length;
        } else {
          stats.errors++;
        }
      } catch {
        stats.errors++;
      }

      // Polite rate limit between queries
      await delay(500);
    }

    // Brief pause between cities
    await delay(1000);
  }

  return NextResponse.json({
    dry_run: dryRun,
    cities: cities.length,
    categories: categories.length,
    ...stats,
  });
}

// Map free-text category to ICP segment
function categoryToSegment(category: string): string {
  const c = category.toLowerCase();
  if (c.includes('supply') || c.includes('cosmetics') || c.includes('retailer') || c.includes('boutique clothing') || c.includes('jewelry')) return 'retailer';
  if (c.includes('influencer') || c.includes('makeup artist')) return 'influencer';
  if (c.includes('medspa') || c.includes('medical spa')) return 'medspa';
  if (c.includes('gym') || c.includes('fitness') || c.includes('yoga') || c.includes('pilates') || c.includes('crossfit') || c.includes('martial arts') || c.includes('personal training')) return 'fitness';
  if (c.includes('dentist') || c.includes('dental') || c.includes('chiropractic') || c.includes('therapist') || c.includes('mental health')) return 'healthcare';
  if (c.includes('restaurant') || c.includes('dining') || c.includes('cafe') || c.includes('coffee') || c.includes('bakery') || c.includes('bar') || c.includes('nightclub')) return 'restaurant';
  if (c.includes('hotel') || c.includes('bed breakfast') || c.includes('event venue')) return 'hospitality';
  if (c.includes('real estate') || c.includes('realtor')) return 'real_estate';
  if (c.includes('law firm') || c.includes('attorney') || c.includes('accounting') || c.includes('insurance') || c.includes('mortgage')) return 'professional_services';
  if (c.includes('marketing agency')) return 'marketing_agency';
  if (c.includes('contractor') || c.includes('cleaning') || c.includes('landscaping') || c.includes('lawn')) return 'home_services';
  if (c.includes('auto dealer') || c.includes('auto repair') || c.includes('mechanic') || c.includes('detailing')) return 'automotive';
  if (c.includes('tutoring') || c.includes('dance studio') || c.includes('music school')) return 'education';
  return 'salon';
}

interface PlaceV1 {
  id?: string;
  displayName?: { text?: string };
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  types?: string[];
  primaryType?: string;
}

function componentOf(comps: PlaceV1['addressComponents'], types: string[]) {
  return comps?.find((c) => c.types?.some((t) => types.includes(t)))?.longText;
}

function componentShort(comps: PlaceV1['addressComponents'], types: string[]) {
  const c = comps?.find((c) => c.types?.some((t) => types.includes(t)));
  return c?.shortText ?? c?.longText;
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
