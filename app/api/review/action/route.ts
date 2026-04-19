import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { scoreLead } from '@/utils/scoring/score';

/**
 * POST /api/review/action
 * Body: { lead_id: string, action: 'approve' | 'reject' | 'requeue' | 'rescore', note?: string }
 *
 * Operator decisions on the review queue. All actions are written to
 * lead_events so the audit trail survives even if a row is re-scored
 * later. Tenant scope is enforced by RLS via the user-scoped client.
 */
type Action = 'approve' | 'reject' | 'requeue' | 'rescore';

const ALLOWED: Action[] = ['approve', 'reject', 'requeue', 'rescore'];

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const leadId = typeof body?.lead_id === 'string' ? body.lead_id : '';
  const action = body?.action as Action | undefined;
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : undefined;

  if (!leadId) {
    return NextResponse.json({ error: 'lead_id required' }, { status: 400 });
  }
  if (!action || !ALLOWED.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of ${ALLOWED.join('|')}` },
      { status: 400 }
    );
  }

  // Confirm the lead belongs to a client the caller owns. RLS will also
  // block writes, but failing fast gives a cleaner error.
  const { data: lead, error: readErr } = await supabase
    .from('leads')
    .select(
      'id, client_id, email, phone_e164, first_name, last_name, company, title, city, region, country, icp_segment, tags, rating, rating_count, syntax_valid, mx_valid, smtp_valid, is_disposable, is_duplicate, is_suppressed, reject_reason, review_state, export_eligible, quality_score, source_tier, reason_codes'
    )
    .eq('id', leadId)
    .single();
  if (readErr || !lead) {
    return NextResponse.json({ error: 'lead not found' }, { status: 404 });
  }

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    reviewed_at: nowIso,
    reviewed_by: user.id,
  };
  const reason_codes = [...(lead.reason_codes ?? [])];

  switch (action) {
    case 'approve':
      // Operator override: send it to export even if auto-scoring quarantined it.
      patch.review_state = 'approved';
      patch.export_eligible = true;
      if (!reason_codes.includes('operator_approved')) reason_codes.push('operator_approved');
      patch.reason_codes = reason_codes;
      break;

    case 'reject':
      patch.review_state = 'rejected';
      patch.export_eligible = false;
      if (!reason_codes.includes('operator_rejected')) reason_codes.push('operator_rejected');
      patch.reason_codes = reason_codes;
      break;

    case 'requeue':
      patch.review_state = 'pending';
      patch.export_eligible = false;
      break;

    case 'rescore': {
      // Re-run the deterministic scoring rubric against the lead's current
      // fields. Used after enrichment fills in missing firmographics.
      const rescored = scoreLead({
        syntax_valid: lead.syntax_valid,
        mx_valid: lead.mx_valid,
        smtp_valid: lead.smtp_valid,
        is_disposable: lead.is_disposable,
        is_duplicate: lead.is_duplicate,
        is_suppressed: lead.is_suppressed,
        reject_reason: lead.reject_reason,
        email: lead.email,
        phone_e164: lead.phone_e164,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company: lead.company,
        title: lead.title,
        city: lead.city,
        region: lead.region,
        country: lead.country,
        icp_segment: lead.icp_segment,
        tags: lead.tags,
        rating: lead.rating,
        rating_count: lead.rating_count,
        source_kind: null,
      });
      patch.quality_score = rescored.quality_score;
      patch.quality_tier = rescored.quality_tier;
      patch.verification_status = rescored.verification_status;
      patch.source_tier = lead.source_tier ?? rescored.source_tier;
      patch.reason_codes = rescored.reason_codes;
      patch.review_state = rescored.review_state;
      patch.export_eligible = rescored.export_eligible;
      break;
    }
  }

  const { error: updErr } = await supabase.from('leads').update(patch).eq('id', leadId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await supabase.from('lead_events').insert({
    lead_id: leadId,
    kind: `review.${action}`,
    detail: {
      actor: user.id,
      note,
      from_state: lead.review_state,
      to_state: patch.review_state,
    },
  });

  return NextResponse.json({
    lead_id: leadId,
    action,
    review_state: patch.review_state,
    export_eligible: patch.export_eligible,
  });
}
