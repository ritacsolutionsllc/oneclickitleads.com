import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import { rescoreLead } from '@/utils/scoring/rescore';
import type { ExportTier } from '@/utils/scoring/tier';

/**
 * POST /api/dashboard/leads/:id/review
 *   body: { action: 'approve' | 'discard' | 'reverify', note?: string }
 *
 * Operator action on a lead parked in the review queue (export_tier = 'review'
 * or any `manual` policy tier). Verifies the caller owns the client via the
 * user-scoped Supabase client, then performs the write through the admin
 * client so the lead_events audit row is guaranteed (lead_events has no
 * INSERT RLS policy today — only SELECT).
 *
 * Actions:
 *   - approve  → promote to 'prospecting' (or keep higher if composite already >=65).
 *                Writes reject_reason=null so it exports cleanly.
 *   - discard  → force tier='discard' + reject_reason='manual_discard'.
 *   - reverify → rescore from current field state. Used after the operator
 *                filled in missing company/title or after a re-enrichment run.
 *
 * Every action is logged to lead_events with the operator's user id so the
 * audit trail is complete for CCPA / internal QA.
 */

type Action = 'approve' | 'discard' | 'reverify';
const VALID_ACTIONS: Action[] = ['approve', 'discard', 'reverify'];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params;
  if (!leadId) return NextResponse.json({ error: 'lead id required' }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? '') as Action;
  const note = typeof body?.note === 'string' ? String(body.note).slice(0, 500) : undefined;
  if (!VALID_ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of ${VALID_ACTIONS.join(', ')}` },
      { status: 400 }
    );
  }

  // Ownership check via RLS: if the user can't see the lead, they can't act on it.
  const { data: lead } = await supabase
    .from('leads')
    .select('id, client_id, export_tier, composite_score')
    .eq('id', leadId)
    .maybeSingle<{
      id: string;
      client_id: string;
      export_tier: ExportTier | null;
      composite_score: number | null;
    }>();
  if (!lead) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const admin = createAdminClient();
  const now = new Date().toISOString();

  if (action === 'reverify') {
    const res = await rescoreLead(admin as never, leadId, {
      verifiedAt: now,
      verifiedBy: `operator:${user.id}`,
    });
    if (!res) return NextResponse.json({ error: 'rescore failed' }, { status: 500 });
    await admin.from('lead_events').insert({
      lead_id: leadId,
      kind: 'reverified',
      detail: {
        by: user.id,
        note,
        composite_score: res.composite_score,
        export_tier: res.export_tier,
      },
    });
    return NextResponse.json({
      id: leadId,
      action,
      composite_score: res.composite_score,
      export_tier: res.export_tier,
    });
  }

  if (action === 'discard') {
    const { error } = await admin
      .from('leads')
      .update({
        export_tier: 'discard',
        reject_reason: 'manual_discard',
      })
      .eq('id', leadId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await admin.from('lead_events').insert({
      lead_id: leadId,
      kind: 'discarded',
      detail: { by: user.id, note, prior_tier: lead.export_tier },
    });
    return NextResponse.json({ id: leadId, action, export_tier: 'discard' });
  }

  // action === 'approve'
  const composite = Number(lead.composite_score ?? 0);
  // Respect the natural tier band when it's already >= 65 (standard or better),
  // otherwise promote a review-band lead to prospecting so it becomes eligible
  // under the default policy (which allows prospecting).
  const promoted: ExportTier =
    composite >= 80 ? 'premium' : composite >= 65 ? 'standard' : 'prospecting';
  const { error } = await admin
    .from('leads')
    .update({
      export_tier: promoted,
      reject_reason: null,
    })
    .eq('id', leadId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await admin.from('lead_events').insert({
    lead_id: leadId,
    kind: 'approved',
    detail: {
      by: user.id,
      note,
      prior_tier: lead.export_tier,
      promoted_to: promoted,
      composite_score: composite,
    },
  });
  return NextResponse.json({ id: leadId, action, export_tier: promoted });
}
