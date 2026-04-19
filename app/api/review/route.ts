import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

/**
 * Review-queue actions for leads in export_eligibility = 'review' or
 * 'quarantine'. Thin wrapper around a Supabase update — RLS enforces
 * that the caller owns the client the lead belongs to.
 *
 * GET  /api/review?client=chella&state=review&limit=50
 *   -> list leads currently in review/quarantine with their reason codes
 *
 * POST /api/review
 *   body: { lead_id: string, action: 'approve' | 'reject' | 'requeue' }
 *   - approve: mark export_eligibility='eligible', review_status='approved'
 *   - reject:  mark export_eligibility='rejected',  review_status='rejected'
 *   - requeue: put back into 'review' so a reverify pass can re-score it
 */

type Action = 'approve' | 'reject' | 'requeue';

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(req.url);
  const clientSlug = searchParams.get('client');
  const state = searchParams.get('state') ?? 'review';
  const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
  if (!clientSlug) return NextResponse.json({ error: 'client required' }, { status: 400 });
  if (!['review', 'quarantine', 'rejected'].includes(state)) {
    return NextResponse.json(
      { error: 'state must be one of review|quarantine|rejected' },
      { status: 400 }
    );
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('slug', clientSlug)
    .eq('owner_user', user.id)
    .single();
  if (!client) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { data, error } = await supabase
    .from('leads')
    .select(
      'id, email, phone_e164, first_name, last_name, company, city, region, icp_segment, quality_score, verification_status, source_tier, export_eligibility, review_status, reason_codes, last_verified_at, created_at'
    )
    .eq('client_id', client.id)
    .eq('export_eligibility', state)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ leads: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { lead_id, action } = (await req.json()) as { lead_id?: string; action?: Action };
  if (!lead_id || !action) {
    return NextResponse.json({ error: 'lead_id and action required' }, { status: 400 });
  }
  if (!['approve', 'reject', 'requeue'].includes(action)) {
    return NextResponse.json(
      { error: 'action must be approve|reject|requeue' },
      { status: 400 }
    );
  }

  const patch =
    action === 'approve'
      ? {
          export_eligibility: 'eligible',
          review_status: 'approved',
          reviewed_at: new Date().toISOString(),
          reviewed_by: user.id,
        }
      : action === 'reject'
      ? {
          export_eligibility: 'rejected',
          review_status: 'rejected',
          reviewed_at: new Date().toISOString(),
          reviewed_by: user.id,
        }
      : {
          export_eligibility: 'review',
          review_status: 'pending',
          reviewed_at: null,
          reviewed_by: null,
        };

  // RLS on public.leads scopes the update to leads in clients the user
  // owns, so no extra client-ownership check is needed here.
  const { data, error } = await supabase
    .from('leads')
    .update(patch)
    .eq('id', lead_id)
    .select('id, export_eligibility, review_status')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json({ lead: data });
}
