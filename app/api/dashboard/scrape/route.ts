import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

const VALID_SOURCES = ['osm', 'places', 'harvest', 'enrich', 'rescrub'] as const;
type Source = (typeof VALID_SOURCES)[number];

const VALID_SEGMENTS = ['salon', 'b2c_beauty', 'influencer', 'retailer'] as const;

/**
 * POST /api/dashboard/scrape
 *
 * Auth-protected proxy that verifies the requesting user owns the target
 * client before forwarding to the internal scraper routes. The browser
 * never needs INGEST_SECRET — this route adds it server-side.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json();
  const source = body.source as Source;
  const clientSlug = String(body.client_slug ?? '').slice(0, 64);

  if (!VALID_SOURCES.includes(source)) {
    return NextResponse.json(
      { error: `source must be one of: ${VALID_SOURCES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!clientSlug) return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  // Confirm the user owns this client (RLS alone isn't enough here since we
  // use the admin client in downstream routes)
  const { data: clientRow } = await supabase
    .from('clients')
    .select('id')
    .eq('slug', clientSlug)
    .eq('owner_user', user.id)
    .single();
  if (!clientRow) return NextResponse.json({ error: 'client not found' }, { status: 404 });

  const origin = new URL(req.url).origin;
  const secret = process.env.INGEST_SECRET ?? '';
  const segment = VALID_SEGMENTS.includes(body.segment) ? body.segment : 'salon';

  try {
    if (source === 'osm') {
      const shop = String(body.shop ?? 'beauty').slice(0, 50);
      const city = String(body.city ?? '').slice(0, 100);
      const region = String(body.region ?? '').slice(0, 50);
      const qs = new URLSearchParams({ client: clientSlug, shop, city, region, segment });
      const res = await fetch(`${origin}/api/scrape-osm?${qs}`, {
        signal: AbortSignal.timeout(55_000),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    }

    if (source === 'places') {
      const query = String(body.query ?? '').slice(0, 200);
      if (!query) return NextResponse.json({ error: 'query is required for Places' }, { status: 400 });
      const qs = new URLSearchParams({ client: clientSlug, query, segment });
      const res = await fetch(`${origin}/api/places-salons?${qs}`, {
        signal: AbortSignal.timeout(55_000),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    }

    if (source === 'harvest') {
      const limit = Math.min(200, Math.max(1, Number(body.limit ?? 50)));
      const res = await fetch(`${origin}/api/harvest-emails`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
        body: JSON.stringify({ client_slug: clientSlug, limit }),
        signal: AbortSignal.timeout(55_000),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    }

    if (source === 'enrich') {
      const batchSize = Math.min(200, Math.max(1, Number(body.batch_size ?? 100)));
      const res = await fetch(`${origin}/api/enrich`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
        body: JSON.stringify({ client_slug: clientSlug, batch_size: batchSize }),
        signal: AbortSignal.timeout(55_000),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    }

    if (source === 'rescrub') {
      const limit = Math.min(500, Math.max(1, Number(body.limit ?? 100)));
      const res = await fetch(`${origin}/api/dashboard/rescrub`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
        body: JSON.stringify({ client_slug: clientSlug, limit }),
        signal: AbortSignal.timeout(55_000),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    }
  } catch (err) {
    console.error('[dashboard/scrape]', err);
    return NextResponse.json({ error: 'scrape timed out or failed — check server logs' }, { status: 500 });
  }

  return NextResponse.json({ error: 'unhandled source' }, { status: 400 });
}
