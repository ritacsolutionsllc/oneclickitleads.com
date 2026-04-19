import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubEmail } from '@/utils/scrub/email';
import { scoreLead, toLeadColumns } from '@/utils/scoring/quality';

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
      'id, website, phone_e164, company, title, city, region, country, icp_segment, tags'
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

    const scrubbed = await scrubEmail(top.value);
    const now = new Date();
    // Hunter is a paid enrichment API -> tier B, which combined with an
    // MX-valid address is enough to clear the identity gate.
    const verdict = scoreLead({
      email: scrubbed.normalized,
      phone_e164: t.phone_e164 ?? null,
      first_name: top.first_name ?? null,
      last_name: top.last_name ?? null,
      company: t.company ?? null,
      title: top.position ?? t.title ?? null,
      city: t.city ?? null,
      region: t.region ?? null,
      country: t.country ?? null,
      icp_segment: t.icp_segment ?? null,
      tags: t.tags ?? [],
      syntax_valid: scrubbed.syntax_valid,
      mx_valid: scrubbed.mx_valid,
      smtp_valid: scrubbed.smtp_valid,
      is_disposable: scrubbed.is_disposable,
      reject_reason: scrubbed.reject_reason ?? null,
      source_kind: 'hunter',
      last_verified_at: now,
    });
    await supabase
      .from('leads')
      .update({
        email: scrubbed.normalized,
        first_name: top.first_name ?? null,
        last_name: top.last_name ?? null,
        title: top.position ?? null,
        syntax_valid: scrubbed.syntax_valid,
        mx_valid: scrubbed.mx_valid,
        smtp_valid: scrubbed.smtp_valid,
        is_disposable: scrubbed.is_disposable,
        scrub_score: scrubbed.score,
        reject_reason: scrubbed.reject_reason ?? null,
        ...toLeadColumns(verdict, now),
      })
      .eq('id', t.id);
    updated++;
  }

  return NextResponse.json({ enriched: updated, checked: targets?.length ?? 0 });
}
