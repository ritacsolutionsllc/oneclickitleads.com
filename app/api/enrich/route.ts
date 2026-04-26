import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scrubEmail } from '@/utils/scrub/email';

/**
 * POST /api/enrich
 * Body: { client_slug, batch_size?: number }
 *
 * Finds leads with a website (stored in raw->source_url) but no email, calls
 * Hunter.io domain-search, validates the result, and writes it back.
 * Run /api/dashboard/rescrub afterward to run the full scrub pipeline.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { client_slug, batch_size = 100 } = await req.json();
  const hunter = process.env.HUNTER_API_KEY;
  if (!hunter) return NextResponse.json({ error: 'HUNTER_API_KEY not set — add it in Vercel env vars' }, { status: 500 });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', client_slug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  // source_url lives in the raw JSONB field — query with ->> operator
  const { data: targets } = await supabase
    .from('leads')
    .select('id, raw')
    .eq('client_id', client.id)
    .is('email', null)
    .not('raw->>source_url', 'is', null)
    .limit(Math.min(200, Math.max(1, Number(batch_size))));

  let updated = 0;
  let skipped = 0;

  for (const t of targets ?? []) {
    const siteUrl = (t.raw as { source_url?: string } | null)?.source_url;
    if (!siteUrl) continue;

    let domain: string;
    try {
      domain = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`)
        .hostname.replace(/^www\./, '');
    } catch {
      skipped++;
      continue;
    }

    const r = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunter}&limit=1`
    );
    if (!r.ok) { skipped++; continue; }

    const { data } = (await r.json()) as {
      data?: { emails?: { value?: string; confidence?: number; first_name?: string; last_name?: string; position?: string }[] };
    };
    const top = data?.emails?.[0];
    if (!top?.value || (top.confidence ?? 0) < 70) { skipped++; continue; }

    // Validate the email before writing — don't trust Hunter blindly
    const check = await scrubEmail(top.value);
    if (!check.syntax_valid || !check.mx_valid || check.is_disposable) { skipped++; continue; }

    await supabase
      .from('leads')
      .update({
        email: check.normalized || top.value,
        first_name: top.first_name ?? null,
        last_name: top.last_name ?? null,
        title: top.position ?? null,
        syntax_valid: check.syntax_valid,
        mx_valid: check.mx_valid,
        smtp_valid: check.smtp_valid,
        is_disposable: check.is_disposable,
        scrub_score: check.score,
        reject_reason: null,
      })
      .eq('id', t.id);
    updated++;
  }

  return NextResponse.json({
    enriched: updated,
    skipped,
    checked: targets?.length ?? 0,
    note: 'Run "Scrub List" next to validate dedup/suppression and make leads exportable.',
  });
}
