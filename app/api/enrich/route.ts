import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { rescoreLead } from '@/utils/scoring/rescore';
import { scrubEmail } from '@/utils/scrub/email';

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

    // Re-validate the email Hunter returned so we don't promote a lead
    // into the export pool on a stale/dead address.
    const emailResult = await scrubEmail(top.value);
    const isClean =
      emailResult.syntax_valid && emailResult.mx_valid && !emailResult.is_disposable;

    await supabase
      .from('leads')
      .update({
        email: emailResult.normalized || top.value,
        first_name: top.first_name ?? null,
        last_name: top.last_name ?? null,
        title: top.position ?? null,
        syntax_valid: emailResult.syntax_valid,
        mx_valid: emailResult.mx_valid,
        smtp_valid: emailResult.smtp_valid,
        is_disposable: emailResult.is_disposable,
        scrub_score: emailResult.score,
        reject_reason: emailResult.reject_reason ?? null,
        is_scrubbed: isClean,
      })
      .eq('id', t.id);
    try {
      await rescoreLead(supabase, t.id, { verifiedBy: 'hunter-enrich' });
    } catch (e) {
      console.error('[enrich] rescore failed', t.id, e);
    }
    updated++;
  }

  return NextResponse.json({ enriched: updated, checked: targets?.length ?? 0 });
}
