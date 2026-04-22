import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch, scoringInsertFields } from '@/utils/scrub/pipeline';
import { loadClientScoringContextBySlug } from '@/utils/scoring/client-context';
import { trustTierForSource } from '@/utils/scoring/sources';

/**
 * POST /api/ingest
 * Body: { client_slug: string, source: { kind, label, source_url? }, rows: RawLead[] }
 *
 * Server-only (admin client). Call from:
 *   - Apollo/Common Room import jobs
 *   - ScrapingBee/BrightData harvesters
 *   - Uploaded CSVs from the dashboard
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { client_slug, source, rows } = body ?? {};
  if (!client_slug || !Array.isArray(rows)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  // Bound the batch so a single request can't exhaust memory/timeout.
  // Callers with more data should paginate; 50k already takes ~5min.
  const MAX_ROWS = 50_000;
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `too many rows: ${rows.length} (max ${MAX_ROWS} per request)` },
      { status: 413 }
    );
  }

  const supabase = createAdminClient();

  const ctx = await loadClientScoringContextBySlug(supabase, client_slug);
  if (!ctx) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const sourceKind = source?.kind ?? 'api';
  const sourceTrustTier = trustTierForSource(sourceKind);

  const { data: srcRow } = await supabase
    .from('sources')
    .insert({
      client_id: ctx.clientId,
      kind: sourceKind,
      label: source?.label ?? null,
      source_url: source?.source_url ?? null,
      trust_tier: sourceTrustTier,
    })
    .select('id').single();

  const scrubbed = await scrubBatch(supabase as never, ctx.clientId, rows, {
    doEnrich: true,
    sourceTrustTier,
    clientIcpTargets: ctx.icpTargets,
    exportPolicy: ctx.exportPolicy,
  });

  const inserts = scrubbed.map((s) => ({
    client_id: ctx.clientId,
    source_id: srcRow?.id,
    first_name: s.first_name,
    last_name: s.last_name,
    email: s.normalized_email,
    phone_e164: s.phone_e164,
    company: s.company,
    title: s.title,
    linkedin_url: (s as { linkedin_url?: string }).linkedin_url,
    city: s.city,
    region: s.region,
    country: s.country,
    icp_segment: s.icp_segment,
    tags: s.tags ?? [],
    is_scrubbed: s.is_scrubbed,
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    is_disposable: s.is_disposable,
    is_duplicate: s.is_duplicate,
    is_suppressed: s.is_suppressed,
    scrub_score: s.scrub_score,
    reject_reason: s.reject_reason,
    ...scoringInsertFields(s),
    raw: s,
    scrubbed_at: new Date().toISOString(),
  }));

  // upsert on (client_id, email_hash) — hash is computed by the DB trigger
  const { error } = await supabase.from('leads').insert(inserts);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ingested: inserts.length,
    clean: inserts.filter((r) => r.is_scrubbed).length,
  });
}
