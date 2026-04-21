import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import Papa from 'papaparse';
import { enforceExport, maxRowsForExport } from '@/utils/plans/enforce';
import { planByTier } from '@/lib/plans';
import { allowedTiers, type ExportPolicy, type ExportTier } from '@/utils/scoring/tier';

/**
 * GET /api/export?client=chella&format=csv|smartly&segment=salon&tier=standard&min_score=60
 *
 * - Only export rows where is_scrubbed = true (defense in depth; RLS also enforces tenant).
 * - Only export rows whose export_tier is `allow`ed by the client's export_policy.
 *   Tiers marked `manual` or `block` never ship through this endpoint; `manual`
 *   tiers (e.g. review) go through the review queue UI.
 * - Plan cap enforced via v_client_usage.
 * - Writes an `exports` row for audit.
 */
const VALID_TIERS: ExportTier[] = [
  'premium',
  'standard',
  'prospecting',
  'review',
  'hold',
  'discard',
];

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(req.url);
  const clientSlug = searchParams.get('client');
  const format = searchParams.get('format') ?? 'csv';
  const segment = searchParams.get('segment');
  const minScore = Number(searchParams.get('min_score') ?? 0);
  const tierFilter = searchParams.get('tier');
  if (!clientSlug) return NextResponse.json({ error: 'client required' }, { status: 400 });
  if (tierFilter && !VALID_TIERS.includes(tierFilter as ExportTier)) {
    return NextResponse.json(
      { error: `tier must be one of ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    );
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: client } = await supabase
    .from('clients')
    .select('id, name, plan, export_policy')
    .eq('slug', clientSlug)
    .eq('owner_user', user.id)
    .single();
  if (!client) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Plan enforcement
  const cap = await enforceExport(client.id);
  if (!cap.ok) {
    return NextResponse.json(
      {
        error: 'Monthly plan cap reached',
        detail: `You've exported ${cap.used} / ${cap.cap} clean leads on the ${cap.plan} plan this month.`,
        upgrade_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing`,
      },
      { status: 402 }
    );
  }

  const plan = planByTier(client.plan);
  const rowLimit = maxRowsForExport(plan, cap.remaining ?? 10_000);

  const policy = (client.export_policy ?? null) as ExportPolicy | null;
  const autoAllowed = allowedTiers(policy);
  // If the caller asked for a specific tier, only honor it if policy allows it.
  const tiersToExport: ExportTier[] =
    tierFilter && autoAllowed.includes(tierFilter as ExportTier)
      ? [tierFilter as ExportTier]
      : autoAllowed;

  if (tiersToExport.length === 0) {
    return NextResponse.json(
      { error: 'No tiers are enabled for export on this account.' },
      { status: 400 }
    );
  }

  const floor = Math.max(
    minScore,
    Number(policy?.min_composite_score ?? 0)
  );

  let q = supabase
    .from('leads')
    .select(
      'email, first_name, last_name, phone_e164, company, title, icp_segment, city, region, country, composite_score, export_tier, review_state, scrub_score'
    )
    .eq('client_id', client.id)
    .eq('is_scrubbed', true)
    .in('export_tier', tiersToExport)
    .order('composite_score', { ascending: false, nullsFirst: false })
    .limit(rowLimit);
  if (segment) q = q.eq('icp_segment', segment);
  if (floor > 0) q = q.gte('composite_score', floor);

  const { data: leads, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Review-tier leads only ship when an operator has explicitly approved
  // them; rejected leads never ship regardless of tier. `auto` and
  // `approved` are the only states that flow through.
  const rows = (leads ?? []).filter((l) => {
    if (l.review_state === 'rejected') return false;
    if (l.export_tier === 'review') return l.review_state === 'approved';
    return true;
  });

  await supabase.from('exports').insert({
    client_id: client.id,
    destination: format === 'smartly' ? 'smartly' : 'csv',
    row_count: rows.length,
    filters: {
      segment,
      min_score: minScore || undefined,
      min_composite_score: floor || undefined,
      tiers: tiersToExport,
    },
    created_by: user.id,
  });

  if (format === 'smartly') {
    const hashed = await Promise.all(
      rows.map(async (r) => ({ email_sha256: await sha256(r.email ?? '') }))
    );
    return NextResponse.json({ account_id: process.env.SMARTLY_ACCOUNT_ID, audience: hashed });
  }

  const csv = Papa.unparse(rows);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${clientSlug}-leads-${new Date().toISOString().slice(0,10)}.csv"`,
    },
  });
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.trim().toLowerCase()));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
