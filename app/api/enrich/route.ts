import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { scoreLead, type SourceTier } from '@/utils/quality/score';
import { hasMxRecord, hasValidSyntax, isDisposable } from '@/utils/scrub/email';

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
    .select('id, website, company, phone_e164, icp_segment, source_tier, is_duplicate, is_suppressed')
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

    const email = top.value.toLowerCase();
    const syntax = hasValidSyntax(email);
    const disposable = syntax ? isDisposable(email) : false;
    const mx = syntax && !disposable ? await hasMxRecord(email) : false;
    // Hunter 70+ confidence hits → tier b; preserve existing tier when higher.
    const tier: SourceTier = (t.source_tier as SourceTier | null) === 'a' ? 'a' : 'b';
    const quality = scoreLead({
      email,
      phone_e164: t.phone_e164,
      first_name: top.first_name ?? null,
      last_name: top.last_name ?? null,
      company: t.company,
      title: top.position ?? null,
      icp_segment: t.icp_segment,
      syntax_valid: syntax,
      mx_valid: mx,
      smtp_valid: false,
      is_disposable: disposable,
      is_duplicate: !!t.is_duplicate,
      is_suppressed: !!t.is_suppressed,
      source_tier: tier,
      verified_at: mx ? new Date() : null,
    });
    await supabase
      .from('leads')
      .update({
        email,
        first_name: top.first_name ?? null,
        last_name: top.last_name ?? null,
        title: top.position ?? null,
        syntax_valid: syntax,
        mx_valid: mx,
        is_disposable: disposable,
        quality_score: quality.quality_score,
        verification_status: quality.verification_status,
        source_tier: tier,
        export_eligibility: quality.export_eligibility,
        reason_codes: quality.reason_codes,
        verified_at: mx ? new Date().toISOString() : null,
      })
      .eq('id', t.id);
    updated++;
  }

  return NextResponse.json({ enriched: updated, checked: targets?.length ?? 0 });
}
