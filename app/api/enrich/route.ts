import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { rescoreLead } from '@/utils/scoring/rescore';

/**
 * POST /api/enrich
 * Body: { client_slug, batch_size?: number }
 *
 * Finds leads in the client's DB that have a website but no email, calls
 * Hunter.io domain-search, and writes the top verified email back. Runs
 * nightly via pg_cron or on-demand from the dashboard.
 *
 * Each successful enrichment is followed by a rescore — Hunter-attached
 * emails typically raise identity + completeness scores enough to move a
 * lead from `review`/`hold` into an exportable tier. Without rescoring, the
 * export gate would keep enriched leads quarantined with stale sub-scores.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { client_slug, batch_size = 100 } = await req.json();
  const hunter = process.env.HUNTER_API_KEY;
  if (!hunter) return NextResponse.json({ error: 'HUNTER_API_KEY missing' }, { status: 500 });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', client_slug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const { data: targets } = await supabase
    .from('leads')
    .select('id, website')
    .eq('client_id', client.id)
    .is('email', null)
    .not('website', 'is', null)
    .limit(batch_size);

  let updated = 0;
  for (const t of targets ?? []) {
    if (!t.website) continue;
    const domain = new URL(t.website).hostname.replace(/^www\./, '');
    const r = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunter}&limit=1`
    );
    if (!r.ok) continue;
    const { data } = (await r.json()) as {
      data?: { emails?: { value?: string; confidence?: number; first_name?: string; last_name?: string; position?: string }[] };
    };
    const top = data?.emails?.[0];
    if (!top?.value || (top.confidence ?? 0) < 70) continue;
    const { error: updErr } = await supabase
      .from('leads')
      .update({
        email: top.value,
        first_name: top.first_name ?? null,
        last_name: top.last_name ?? null,
        title: top.position ?? null,
        syntax_valid: true,
      })
      .eq('id', t.id);
    if (updErr) continue;
    // Hunter returns addresses that passed its own deliverability checks
    // (confidence >= 70 by the filter above), so mark the lead as scrubbed
    // and re-run scoring so export_tier reflects the new identity +
    // completeness signals.
    await rescoreLead(supabase as never, t.id, {
      verifiedBy: `hunter:confidence:${top.confidence ?? 0}`,
      setIsScrubbed: true,
    });
    updated++;
  }

  return NextResponse.json({ enriched: updated, checked: targets?.length ?? 0 });
}
