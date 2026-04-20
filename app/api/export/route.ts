import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import Papa from 'papaparse';
import { enforceExport, maxRowsForExport } from '@/utils/plans/enforce';
import { planByTier } from '@/lib/plans';
import {
  applyExportGate,
  EXPORT_MIN_QUALITY_SCORE,
  EXPORT_POLICY_SUMMARY,
} from '@/lib/quality/export-gate';

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

  // Clients can RAISE the quality floor past the platform default but not
  // lower it — the export gate is a floor, not a ceiling.
  const effectiveMinScore = Math.max(minScore || 0, EXPORT_MIN_QUALITY_SCORE);

  let q = supabase
    .from('leads')
    .select(
      'id, email, first_name, last_name, phone_e164, company, title, icp_segment, city, region, country, quality_score, verification_status, reason_codes'
    )
    .eq('client_id', client.id)
    .gte('quality_score', effectiveMinScore)
    .order('quality_score', { ascending: false, nullsFirst: false })
    .order('lead_quality_score', { ascending: false, nullsFirst: false })
    .limit(rowLimit);
  q = applyExportGate(q);
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
      min_score: effectiveMinScore,
      policy: EXPORT_POLICY_SUMMARY,
    },
    created_by: user.id,
  });

  // Flip approved → exported so the audit trail reflects that these rows
  // actually left the platform. Admin client would be required to bypass RLS
  // but our SELECT above already proved ownership, so this is safe under the
  // user's session.
  if (rows.length) {
    await supabase
      .from('leads')
      .update({ lead_status: 'exported' })
      .in('id', rows.map((r) => r.id));
  }

  if (format === 'smartly') {
    const hashed = await Promise.all(
      rows.map(async (r) => ({ email_sha256: await sha256(r.email ?? '') }))
    );
    return NextResponse.json({ account_id: process.env.SMARTLY_ACCOUNT_ID, audience: hashed });
  }

  // Project to the client-facing CSV columns. Internal bookkeeping (id,
  // reason_codes) stays out of the downloaded file.
  const csvRows = rows.map((r) => ({
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    phone_e164: r.phone_e164,
    company: r.company,
    title: r.title,
    icp_segment: r.icp_segment,
    city: r.city,
    region: r.region,
    country: r.country,
    quality_score: r.quality_score,
    verification_status: r.verification_status,
  }));
  const csv = Papa.unparse(csvRows);
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
