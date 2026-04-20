import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scoreLead, toLeadColumns } from '@/lib/scoring/quality';
import { hasMxRecord } from '@/utils/scrub/email';

/**
 * POST /api/enrich
 * Body: { client_slug, batch_size?: number }
 *
 * Finds leads in the client's DB that have a website but no email, calls
 * Hunter.io domain-search, and writes the top verified email back. Runs
 * nightly via pg_cron or on-demand from the dashboard.
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
    .select('id, website, company, title, icp_segment, city, region, country, phone_e164, source_tier')
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

    // Re-score the enriched row. Hunter-provided emails are Hunter-verified
    // (confidence >= 70) so we credit the lead with syntax+MX here and
    // confirm MX in-process for belt-and-suspenders.
    const mxOk = await hasMxRecord(top.value);
    const quality = scoreLead({
      email: top.value,
      phone_e164: t.phone_e164 ?? null,
      syntax_valid: true,
      mx_valid: mxOk,
      smtp_valid: null,
      first_name: top.first_name ?? null,
      last_name: top.last_name ?? null,
      title: top.position ?? null,
      company: t.company ?? null,
      icp_segment: t.icp_segment ?? null,
      city: t.city ?? null,
      region: t.region ?? null,
      country: t.country ?? null,
      observed_at: new Date(),
      // Hunter.io is a tier2 verified B2B directory — a huge upgrade over
      // the row's original tier3 scraped provenance.
      source_kind: 'hunter',
    });

    await supabase
      .from('leads')
      .update({
        email: top.value,
        first_name: top.first_name ?? null,
        last_name: top.last_name ?? null,
        title: top.position ?? null,
        syntax_valid: true,
        mx_valid: mxOk,
        is_scrubbed: mxOk,
        ...toLeadColumns(quality),
      })
      .eq('id', t.id);
    updated++;
  }

  return NextResponse.json({ enriched: updated, checked: targets?.length ?? 0 });
}
