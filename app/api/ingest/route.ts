import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubBatch } from '@/utils/scrub/pipeline';
import { buildLeadRow } from '@/utils/leads/insert';
import type { SourceKind } from '@/utils/scoring/quality';

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

  const { data: srcRow } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: source?.kind ?? 'api',
      label: source?.label ?? null,
      source_url: source?.source_url ?? null,
    })
    .select('id').single();

  const scrubbed = await scrubBatch(supabase as never, client.id, rows);

  const sourceKind = (source?.kind ?? 'api') as SourceKind;
  const inserts = scrubbed.map((s) =>
    buildLeadRow(s, {
      client_id: client.id,
      source_id: srcRow?.id,
      source_kind: sourceKind,
    })
  );

  // upsert on (client_id, email_hash) — hash is computed by the DB trigger
  const { error } = await supabase.from('leads').insert(inserts);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ingested: inserts.length,
    eligible: inserts.filter((r) => r.export_eligibility === 'eligible').length,
    review: inserts.filter((r) => r.export_eligibility === 'review').length,
    quarantine: inserts.filter((r) => r.export_eligibility === 'quarantine').length,
    rejected: inserts.filter((r) => r.export_eligibility === 'rejected').length,
  });
}
