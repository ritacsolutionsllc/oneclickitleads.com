import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import Papa from 'papaparse';
import { enforceExport, maxRowsForExport } from '@/utils/plans/enforce';
import { planByTier } from '@/lib/plans';
import { isAdminEmail } from '@/utils/admin';

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
  const scrubbed = searchParams.get('scrubbed');
  const queryTerm = searchParams.get('q');
  const minScore = Number(searchParams.get('min_score') ?? 0);
  if (!clientSlug) return NextResponse.json({ error: 'client required' }, { status: 400 });
  if (scrubbed === '0') {
    return NextResponse.json(
      { error: 'Rejected leads cannot be exported. Set status to scrubbed or any.' },
      { status: 400 }
    );
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const admin = isAdminEmail(user.email);

  let clientQuery = supabase
    .from('clients')
    .select('id, name, plan')
    .eq('slug', clientSlug);
  if (!admin) clientQuery = clientQuery.eq('owner_user', user.id);

  const { data: client } = await clientQuery.single();
  if (!client) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Plan enforcement
  let rowLimit = 1_000_000;
  if (!admin) {
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
    rowLimit = maxRowsForExport(plan, cap.remaining ?? 10_000);
  }

  let q = supabase
    .from('leads')
    .select('email, first_name, last_name, phone_e164, company, title, icp_segment, city, region, country, scrub_score, raw')
    .eq('client_id', client.id)
    .eq('is_scrubbed', true)
    .order('lead_quality_score', { ascending: false, nullsFirst: false })
    .limit(rowLimit);
  if (segment) q = q.eq('icp_segment', segment);
  if (minScore) q = q.gte('scrub_score', minScore);
  if (queryTerm) {
    const term = queryTerm.trim();
    if (term) {
      q = q.or(
        `email.ilike.%${term}%,company.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`
      );
    }
  }

  const { data: leads, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (leads ?? []).map((r) => {
    const raw = r.raw as { source_url?: string } | null;
    return {
      email: r.email,
      first_name: r.first_name,
      last_name: r.last_name,
      phone: r.phone_e164,
      company: r.company,
      title: r.title,
      icp_segment: r.icp_segment,
      city: r.city,
      region: r.region,
      country: r.country,
      website: raw?.source_url ?? null,
      scrub_score: r.scrub_score,
    };
  });

  await supabase.from('exports').insert({
    client_id: client.id,
    destination: format === 'smartly' ? 'smartly' : 'csv',
    row_count: rows.length,
    filters: { segment, scrubbed: scrubbed || undefined, q: queryTerm || undefined, min_score: minScore || undefined },
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
