import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scoreLead, scoringColumns } from '@/lib/quality/score';
import { hasValidSyntax, hasMxRecord, normalizeEmail } from '@/utils/scrub/email';

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
    .select(
      'id, website, phone_e164, company, title, city, region, country, icp_segment, tags, rating, rating_count, source_tier, created_at'
    )
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

    const email = normalizeEmail(top.value);
    const syntax_valid = hasValidSyntax(email);
    const mx_valid = syntax_valid ? await hasMxRecord(email) : false;
    const first_name = top.first_name ?? null;
    const last_name = top.last_name ?? null;
    const title = top.position ?? null;

    const quality = scoreLead({
      email,
      phone_e164: t.phone_e164 ?? null,
      first_name,
      last_name,
      company: t.company ?? null,
      title,
      city: t.city ?? null,
      region: t.region ?? null,
      country: t.country ?? null,
      icp_segment: t.icp_segment ?? null,
      tags: t.tags ?? null,
      syntax_valid,
      mx_valid,
      smtp_valid: false,
      is_disposable: false,
      is_duplicate: false,
      is_suppressed: false,
      source_kind: 'enriched',
      rating: t.rating ?? null,
      rating_count: t.rating_count ?? null,
      created_at: t.created_at ?? null,
      verified_at: new Date(),
    });

    await supabase
      .from('leads')
      .update({
        email,
        first_name,
        last_name,
        title,
        syntax_valid,
        mx_valid,
        is_scrubbed: mx_valid,
        reject_reason: mx_valid ? null : 'no_mx',
        verified_at: new Date().toISOString(),
        ...scoringColumns(quality),
      })
      .eq('id', t.id);
    updated++;
  }

  return NextResponse.json({ enriched: updated, checked: targets?.length ?? 0 });
}
