import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { rescoreLead } from '@/utils/scoring/rescore';
import type { ExportPolicy } from '@/utils/scoring/tier';

/**
 * POST /api/enrich
 * Body: { client_slug, batch_size?: number }
 *
 * Finds leads in the client's DB that have a website but no email, calls
 * Hunter.io domain-search, writes the top verified email back, and
 * re-scores the row so export_tier and reason_codes reflect the new
 * identity/completeness data. Runs nightly via pg_cron or on-demand from
 * the dashboard.
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
    .from('clients')
    .select('id, export_policy')
    .eq('slug', client_slug)
    .single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });
  const exportPolicy = (client.export_policy ?? null) as ExportPolicy | null;

  const { data: targets } = await supabase
    .from('leads')
    .select(
      'id, website, email, phone_e164, first_name, last_name, company, title, linkedin_url, instagram_handle, city, region, country, icp_segment, syntax_valid, mx_valid, smtp_valid, is_disposable, is_duplicate, is_suppressed, is_scrubbed, verified_at, source_id'
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
      data?: {
        emails?: {
          value?: string;
          confidence?: number;
          first_name?: string;
          last_name?: string;
          position?: string;
        }[];
      };
    };
    const top = data?.emails?.[0];
    if (!top?.value || (top.confidence ?? 0) < 70) continue;

    // Hunter.io verified email → treat syntax/MX as valid; SMTP we don't know.
    const enrichedRow = {
      ...t,
      email: top.value,
      first_name: top.first_name ?? t.first_name,
      last_name: top.last_name ?? t.last_name,
      title: top.position ?? t.title,
      syntax_valid: true,
      mx_valid: true,
      is_scrubbed: true,
    };
    const sourceTrustTier = await readSourceTrustTier(supabase, t.source_id as string | null);
    const rescore = rescoreLead(enrichedRow, {
      verifiedBy: `hunter.io:${top.confidence ?? 0}`,
      sourceTrustTier,
      exportPolicy,
      bumpVerifiedAt: true,
    });

    await supabase
      .from('leads')
      .update({
        email: top.value,
        first_name: top.first_name ?? null,
        last_name: top.last_name ?? null,
        title: top.position ?? null,
        syntax_valid: true,
        mx_valid: true,
        is_scrubbed: true,
        reject_reason: null,
        ...rescore,
      })
      .eq('id', t.id);
    updated++;
  }

  return NextResponse.json({ enriched: updated, checked: targets?.length ?? 0 });
}

async function readSourceTrustTier(
  supabase: ReturnType<typeof createAdminClient>,
  sourceId: string | null
): Promise<number | null> {
  if (!sourceId) return null;
  const { data } = await supabase
    .from('sources')
    .select('trust_tier')
    .eq('id', sourceId)
    .single();
  return (data?.trust_tier as number | undefined) ?? null;
}
