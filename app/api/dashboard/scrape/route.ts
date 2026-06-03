import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import { canCustomScrape } from '@/lib/plans';

const VALID_SOURCES = ['places', 'harvest', 'enrich', 'rescrub'] as const;
type Source = (typeof VALID_SOURCES)[number];

const VALID_SEGMENTS = ['salon', 'b2c_beauty', 'influencer', 'retailer'] as const;

/**
 * POST /api/dashboard/scrape
 *
 * Auth-protected proxy that verifies the requesting user owns the target
 * client AND has a plan that permits custom scraping before forwarding
 * to the internal scraper routes.
 *
 * OSM source removed — replaced by pre-scraped inventory.
 * Custom scraping (places/harvest/enrich) is restricted to agency+ plans.
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

  const { data: clientRow } = await supabase
    .from('clients')
    .select('id, plan')
    .eq('slug', clientSlug)
    .eq('owner_user', user.id)
    .single();
  if (!clientRow) return NextResponse.json({ error: 'client not found' }, { status: 404 });

  // ── Plan gate: custom scraping requires agency or enterprise ──────────────
  if (!canCustomScrape(clientRow.plan)) {
    return NextResponse.json(
      {
        error: 'Custom scraping requires the Agency plan ($499/mo).',
        upgrade_url: '/pricing',
        current_plan: clientRow.plan,
        message:
          'Your plan includes access to our pre-scraped US beauty database. ' +
          'Upgrade to Agency to run custom city, query, or niche scrapes.',
      },
      { status: 402 },
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  const origin = new URL(req.url).origin;
  const secret = process.env.INGEST_SECRET ?? '';
  const segment = VALID_SEGMENTS.includes(body.segment) ? body.segment : 'salon';
  const admin = createAdminClient();

  async function recordRun(result: Record<string, unknown>, status: 'ok' | 'error', errorMsg?: string) {
    await admin.from('scrape_runs').insert({
      client_id: clientRow!.id,
      source,
      params: { ...body, client_slug: clientSlug },
      result,
      status,
      error_msg: errorMsg ?? null,
    });
  }

  try {
    let res: Response;

    if (source === 'places') {
      const query = String(body.query ?? '').slice(0, 200);
      if (!query) return NextResponse.json({ error: 'query is required for Places' }, { status: 400 });
      const qs = new URLSearchParams({ client: clientSlug, query, segment });
      res = await fetch(`${origin}/api/places-salons?${qs}`, {
        headers: { 'x-ingest-secret': secret },
        signal: AbortSignal.timeout(55_000),
      });
    } else if (source === 'harvest') {
      const limit = Math.min(200, Math.max(1, Number(body.limit ?? 50)));
      res = await fetch(`${origin}/api/harvest-emails`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
        body: JSON.stringify({ client_slug: clientSlug, limit }),
        signal: AbortSignal.timeout(55_000),
      });
    } else if (source === 'enrich') {
      const batchSize = Math.min(200, Math.max(1, Number(body.batch_size ?? 100)));
      res = await fetch(`${origin}/api/enrich`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
        body: JSON.stringify({ client_slug: clientSlug, batch_size: batchSize }),
        signal: AbortSignal.timeout(55_000),
      });
    } else if (source === 'rescrub') {
      const limit = Math.min(500, Math.max(1, Number(body.limit ?? 100)));
      res = await fetch(`${origin}/api/dashboard/rescrub`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
        body: JSON.stringify({ client_slug: clientSlug, limit }),
        signal: AbortSignal.timeout(55_000),
      });
    } else {
      return NextResponse.json({ error: 'unhandled source' }, { status: 400 });
    }

    const data = await res.json();
    await recordRun(data, res.ok ? 'ok' : 'error', res.ok ? undefined : (data.error ?? 'upstream error'));
    return NextResponse.json(data, { status: res.status });

  } catch (err) {
    const msg = 'scrape timed out or failed — check server logs';
    console.error('[dashboard/scrape]', err);
    await recordRun({}, 'error', msg).catch(() => {});
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
