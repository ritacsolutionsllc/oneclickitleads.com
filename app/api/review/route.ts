import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

/**
 * GET /api/review?client=chella&state=pending|quarantined|rejected&limit=50
 *
 * Returns the operator review queue: leads the scoring engine did not
 * auto-approve. RLS enforces tenant scope; this route just filters + sorts
 * so the dashboard quality UI can render it without writing its own query.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(req.url);
  const clientSlug = searchParams.get('client');
  const state = (searchParams.get('state') ?? 'pending') as
    | 'pending'
    | 'quarantined'
    | 'rejected';
  const limit = Math.min(200, Number(searchParams.get('limit') ?? 50));

  if (!clientSlug) {
    return NextResponse.json({ error: 'client required' }, { status: 400 });
  }
  if (!['pending', 'quarantined', 'rejected'].includes(state)) {
    return NextResponse.json(
      { error: 'state must be pending|quarantined|rejected' },
      { status: 400 }
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('slug', clientSlug)
    .eq('owner_user', user.id)
    .single();
  if (!client) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { data: leads, error } = await supabase
    .from('leads')
    .select(
      'id, email, phone_e164, first_name, last_name, company, title, icp_segment, city, region, country, quality_score, quality_tier, verification_status, source_tier, reason_codes, review_state, export_eligible, created_at, verified_at'
    )
    .eq('client_id', client.id)
    .eq('review_state', state)
    .order('quality_score', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: usage } = await supabase
    .from('v_client_usage')
    .select('review_pending, review_quarantined, eligible_this_month, monthly_cap')
    .eq('client_id', client.id)
    .single();

  return NextResponse.json({
    state,
    count: leads?.length ?? 0,
    usage: usage ?? null,
    leads: leads ?? [],
  });
}
