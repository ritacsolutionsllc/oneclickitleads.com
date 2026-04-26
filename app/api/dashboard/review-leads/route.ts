import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

/**
 * GET /api/dashboard/review-leads?client=<slug>&page=1
 *
 * Returns leads with export_tier = 'review' for the given client.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const clientSlug = searchParams.get('client') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? 1));
  const PAGE_SIZE = 100;

  if (!clientSlug) return NextResponse.json({ error: 'client required' }, { status: 400 });

  const { data: clientRow } = await supabase
    .from('clients').select('id').eq('slug', clientSlug).eq('owner_user', user.id).single();
  if (!clientRow) return NextResponse.json({ error: 'client not found' }, { status: 404 });

  const from = (page - 1) * PAGE_SIZE;
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, company, email, phone_e164, city, region, icp_segment, composite_score, scrub_score, created_at')
    .eq('client_id', clientRow.id)
    .eq('export_tier', 'review')
    .order('composite_score', { ascending: false, nullsFirst: false })
    .range(from, from + PAGE_SIZE - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(leads ?? []);
}
