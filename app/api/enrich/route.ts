import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubEmail } from '@/utils/scrub/email';
import { rescoreLead } from '@/utils/scoring/rescore';

/**
 * POST /api/enrich
 * Body: { client_slug, batch_size?: number }
 *
 * Finds leads in the client's DB that have a site (stored in raw->>source_url
 * by the scrapers) but no email, calls Hunter.io domain-search, writes back
 * the top verified email + syntax/MX/SMTP flags, then rescores so the new
 * identity/completeness signal flows into composite_score + export_tier.
 *
 * Runs nightly via pg_cron or on-demand from the dashboard.
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

  // `website` isn't a column on leads — scrapers stash the site in
  // raw->>source_url. Filter with that and cast in JS.
  const { data: targets, error: qErr } = await supabase
    .from('leads')
    .select('id, raw')
    .eq('client_id', client.id)
    .is('email', null)
    .not('raw->>source_url', 'is', null)
    .limit(batch_size);
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });

  let updated = 0;
  let rescored = 0;
  for (const t of targets ?? []) {
    const site = (t.raw as { source_url?: string } | null)?.source_url;
    if (!site) continue;
    let domain: string;
    try {
      domain = new URL(site.startsWith('http') ? site : `https://${site}`).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    const r = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunter}&limit=1`
    );
    if (!r.ok) continue;
    const { data } = (await r.json()) as {
      data?: { emails?: { value?: string; confidence?: number; first_name?: string; last_name?: string; position?: string }[] };
    };
    const top = data?.emails?.[0];
    if (!top?.value || (top.confidence ?? 0) < 70) continue;

    // Re-validate syntax/MX so the new email lands with the same flags
    // the scrub pipeline would have set. Hunter confidence alone is not
    // a substitute for MX verification.
    const scrub = await scrubEmail(top.value);
    const isScrubbed =
      scrub.syntax_valid && scrub.mx_valid && !scrub.is_disposable;

    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from('leads')
      .update({
        email: scrub.normalized || top.value,
        first_name: top.first_name ?? null,
        last_name: top.last_name ?? null,
        title: top.position ?? null,
        syntax_valid: scrub.syntax_valid,
        mx_valid: scrub.mx_valid,
        smtp_valid: scrub.smtp_valid,
        is_disposable: scrub.is_disposable,
        scrub_score: scrub.score,
        reject_reason: scrub.reject_reason ?? null,
        is_scrubbed: isScrubbed,
        scrubbed_at: now,
      })
      .eq('id', t.id);
    if (upErr) continue;
    updated++;

    const res = await rescoreLead(supabase as never, t.id, {
      verifiedAt: now,
      verifiedBy: `hunter:confidence_${top.confidence ?? 'unknown'}`,
    });
    if (res?.updated) rescored++;
  }

  return NextResponse.json({
    enriched: updated,
    rescored,
    checked: targets?.length ?? 0,
  });
}
