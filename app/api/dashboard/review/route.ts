import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

/**
 * POST /api/dashboard/review
 * Body: { lead_ids: string[], action: 'approve' | 'reject', client_slug: string }
 *
 * Approve: promotes leads from 'review' tier to 'prospecting' and marks
 * is_scrubbed = true so they become exportable.
 * Reject: sets export_tier = 'discard' and is_scrubbed = false.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json();
  const action = body.action as 'approve' | 'reject';
  const leadIds = Array.isArray(body.lead_ids) ? (body.lead_ids as string[]).slice(0, 500) : [];
  const clientSlug = String(body.client_slug ?? '').slice(0, 64);

  if (!['approve', 'reject'].includes(action))
    return NextResponse.json({ error: 'action must be approve or reject' }, { status: 400 });
  if (!leadIds.length)
    return NextResponse.json({ error: 'lead_ids required' }, { status: 400 });
  if (!clientSlug)
    return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  // Confirm ownership
  const { data: clientRow } = await supabase
    .from('clients').select('id').eq('slug', clientSlug).eq('owner_user', user.id).single();
  if (!clientRow) return NextResponse.json({ error: 'client not found' }, { status: 404 });

  const update =
    action === 'approve'
      ? { export_tier: 'prospecting', is_scrubbed: true, reject_reason: null }
      : { export_tier: 'discard', is_scrubbed: false, reject_reason: 'manual_reject' };

  const { error, count } = await supabase
    .from('leads')
    .update(update)
    .eq('client_id', clientRow.id)
    .in('id', leadIds);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ updated: count, action });
}
