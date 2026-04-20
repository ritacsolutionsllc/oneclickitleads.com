import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch } from '@/utils/scrub/pipeline';
import { sourceTierFromKind, scoreToDbFields } from '@/utils/scoring/score';

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

  const supabase = createAdminClient();

  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', client_slug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const sourceKind = source?.kind ?? 'api';
  const sourceTier = sourceTierFromKind(sourceKind);

  const { data: srcRow } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: sourceKind,
      tier: sourceTier,
      label: source?.label ?? null,
      source_url: source?.source_url ?? null,
    })
    .select('id').single();

  const verifiedAt = new Date();
  const scrubbed = await scrubBatch(supabase as never, client.id, rows, {
    sourceKind,
    verifiedAt,
  });

  const inserts = scrubbed.map((s) => ({
    client_id: client.id,
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
    raw: s,
    scrubbed_at: verifiedAt.toISOString(),
    verified_at: verifiedAt.toISOString(),
    ...scoreToDbFields(s.score),
  }));

  // upsert on (client_id, email_hash) — hash is computed by the DB trigger
  const { error } = await supabase.from('leads').insert(inserts);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ingested: inserts.length,
    clean: inserts.filter((r) => r.is_scrubbed).length,
    eligible: inserts.filter((r) => r.export_eligibility === 'eligible').length,
    review: inserts.filter((r) => r.export_eligibility === 'review').length,
    quarantined: inserts.filter((r) => r.export_eligibility === 'quarantined').length,
  });
}
