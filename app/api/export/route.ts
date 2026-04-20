import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import Papa from 'papaparse';
import {
  enforceExport,
  maxRowsForExport,
  minQualityForTier,
} from '@/utils/plans/enforce';
import { planByTier } from '@/lib/plans';

/**
 * GET /api/export?client=chella&format=csv|smartly&segment=salon&min_score=60
 *
 * - Only export rows where is_scrubbed = true (defense in depth; RLS also enforces tenant).
 * - Plan cap enforced via v_client_usage.
 * - Writes an `exports` row for audit.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(req.url);
  const clientSlug = searchParams.get('client');
  const format = searchParams.get('format') ?? 'csv';
  const segment = searchParams.get('segment');
  const minScore = Number(searchParams.get('min_score') ?? 0);
  if (!clientSlug) return NextResponse.json({ error: 'client required' }, { status: 400 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: client } = await supabase
    .from('clients')
    .select('id, name, plan')
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
  const tierFloor = minQualityForTier(plan.tier);
  // The caller may *raise* the bar but never lower it below the tier floor.
  const effectiveMinQuality = Math.max(tierFloor, minScore || 0);

  let q = supabase
    .from('leads')
    .select('email, first_name, last_name, phone_e164, company, title, icp_segment, city, region, country, scrub_score, quality_score, verification_status, source_tier, reason_codes')
    .eq('client_id', client.id)
    .eq('export_eligibility', 'eligible')
    .gte('quality_score', effectiveMinQuality)
    .order('quality_score', { ascending: false, nullsFirst: false })
    .order('lead_quality_score', { ascending: false, nullsFirst: false })
    .limit(rowLimit);
  if (segment) q = q.eq('icp_segment', segment);

  const { data: leads, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = leads ?? [];

  await supabase.from('exports').insert({
    client_id: client.id,
    destination: format === 'smartly' ? 'smartly' : 'csv',
    row_count: rows.length,
    filters: {
      segment,
      min_score: minScore || undefined,
      tier_floor: tierFloor,
      effective_min_quality: effectiveMinQuality,
      gate: 'export_eligibility=eligible',
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
