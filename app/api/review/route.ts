import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { scrubEmail } from '@/utils/scrub/email';
import { scoreLead } from '@/utils/scoring/score';
import { assignTierWithReason, type ExportPolicy } from '@/utils/scoring/tier';

/**
 * Review queue: operator decisions on review-tier leads.
 *
 * GET /api/review?client=<slug>&limit=50
 *   → list pending review-queue rows for the signed-in owner.
 *
 * POST /api/review
 *   body: {
 *     client_slug: string,
 *     lead_id: string,
 *     decision: 'approve' | 'reject' | 'reverify' | 'needs_reverify',
 *     notes?: string
 *   }
 *   Applies the operator's decision:
 *     approve        → review_state='approved' (becomes export-eligible)
 *     reject         → review_state='rejected', export_tier='discard'
 *     needs_reverify → review_state='needs_reverify' (queue re-check)
 *     reverify       → re-runs email scrub + scoring right now
 *
 * Auth: the user must own the target client (RLS enforces this on the
 * UPDATE path; we double-check here so we can return a useful 403).
 */
type Decision = 'approve' | 'reject' | 'reverify' | 'needs_reverify';
const VALID_DECISIONS: Decision[] = ['approve', 'reject', 'reverify', 'needs_reverify'];

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const clientSlug = searchParams.get('client');
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? 50)));
  if (!clientSlug) return NextResponse.json({ error: 'client required' }, { status: 400 });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('slug', clientSlug)
    .eq('owner_user', user.id)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { data, error } = await supabase
    .from('v_client_review_queue')
    .select('*')
    .eq('client_id', client.id)
    .order('composite_score', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ queue: data ?? [], limit });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { client_slug, lead_id, decision, notes } = body as {
    client_slug?: string;
    lead_id?: string;
    decision?: Decision;
    notes?: string;
  };
  if (!client_slug || !lead_id || !decision) {
    return NextResponse.json(
      { error: 'client_slug, lead_id, decision required' },
      { status: 400 }
    );
  }
  if (!VALID_DECISIONS.includes(decision)) {
    return NextResponse.json(
      { error: `decision must be one of ${VALID_DECISIONS.join(', ')}` },
      { status: 400 }
    );
  }
  const trimmedNotes = typeof notes === 'string' ? notes.slice(0, 500) : null;

  const { data: client } = await supabase
    .from('clients')
    .select('id, export_policy')
    .eq('slug', client_slug)
    .eq('owner_user', user.id)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select(
      'id, email, phone_e164, first_name, last_name, company, title, city, region, country, icp_segment, export_tier, review_state, reason_codes, source_id'
    )
    .eq('id', lead_id)
    .eq('client_id', client.id)
    .maybeSingle();
  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 });
  if (!lead) return NextResponse.json({ error: 'lead not found' }, { status: 404 });

  const now = new Date().toISOString();
  const baseAudit = {
    reviewed_at: now,
    reviewed_by: user.id,
    review_notes: trimmedNotes,
  };
  const existingReasons: string[] = Array.isArray(lead.reason_codes) ? lead.reason_codes : [];

  if (decision === 'approve') {
    const reason_codes = Array.from(new Set<string>([...existingReasons, 'operator_approved']));
    const { error } = await supabase
      .from('leads')
      .update({
        ...baseAudit,
        review_state: 'approved',
        reason_codes,
      })
      .eq('id', lead.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ lead_id: lead.id, decision, review_state: 'approved' });
  }

  if (decision === 'reject') {
    const reason_codes = Array.from(new Set<string>([...existingReasons, 'operator_rejected']));
    const { error } = await supabase
      .from('leads')
      .update({
        ...baseAudit,
        review_state: 'rejected',
        export_tier: 'discard',
        reason_codes,
      })
      .eq('id', lead.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ lead_id: lead.id, decision, review_state: 'rejected' });
  }

  if (decision === 'needs_reverify') {
    const reason_codes = Array.from(new Set<string>([...existingReasons, 'operator_needs_reverify']));
    const { error } = await supabase
      .from('leads')
      .update({ ...baseAudit, review_state: 'needs_reverify', reason_codes })
      .eq('id', lead.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ lead_id: lead.id, decision, review_state: 'needs_reverify' });
  }

  // 'reverify': re-run the email scrub + scoring right now. Requires an
  // email on file (you can't reverify what doesn't exist).
  if (!lead.email) {
    return NextResponse.json({ error: 'lead has no email to reverify' }, { status: 400 });
  }
  const verification = await scrubEmail(lead.email);
  const trustTier = await lookupTrustTier(supabase, lead.source_id);
  const policy = (client.export_policy ?? null) as ExportPolicy | null;

  const scores = scoreLead({
    syntax_valid: verification.syntax_valid,
    mx_valid: verification.mx_valid,
    smtp_valid: verification.smtp_valid,
    is_disposable: verification.is_disposable,
    email: verification.normalized,
    phone_e164: lead.phone_e164 ?? null,
    first_name: lead.first_name ?? null,
    last_name: lead.last_name ?? null,
    company: lead.company ?? null,
    title: lead.title ?? null,
    city: lead.city ?? null,
    region: lead.region ?? null,
    country: lead.country ?? null,
    icp_segment: lead.icp_segment ?? null,
    source_trust_tier: trustTier,
    verified_at: null,
  });
  const isScrubbed =
    verification.syntax_valid && verification.mx_valid && !verification.is_disposable;
  const tier = assignTierWithReason({
    composite_score: scores.composite_score,
    is_scrubbed: isScrubbed,
    policy,
  });
  const reason_codes = Array.from(
    new Set<string>([
      ...existingReasons,
      ...scores.reason_codes,
      ...tier.reason_codes,
      'operator_reverified',
    ])
  );

  const { error } = await supabase
    .from('leads')
    .update({
      ...baseAudit,
      email: verification.normalized || lead.email,
      syntax_valid: verification.syntax_valid,
      mx_valid: verification.mx_valid,
      smtp_valid: verification.smtp_valid,
      is_disposable: verification.is_disposable,
      is_scrubbed: isScrubbed,
      scrub_score: verification.score,
      reject_reason: verification.reject_reason ?? null,
      identity_score: scores.identity_score,
      icp_fit_score: scores.icp_fit_score,
      completeness_score: scores.completeness_score,
      freshness_score: scores.freshness_score,
      intent_score: scores.intent_score,
      source_confidence: scores.source_confidence,
      export_tier: tier.tier,
      review_state: tier.review_state,
      reason_codes,
      verified_at: now,
      verified_by: 'review:reverify',
    })
    .eq('id', lead.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    lead_id: lead.id,
    decision,
    export_tier: tier.tier,
    review_state: tier.review_state,
    composite_score: scores.composite_score,
  });
}

type UserClient = Awaited<ReturnType<typeof createClient>>;

async function lookupTrustTier(
  supabase: UserClient,
  sourceId: string | null | undefined
): Promise<number> {
  if (!sourceId) return 4;
  const { data } = await supabase
    .from('sources')
    .select('trust_tier')
    .eq('id', sourceId)
    .maybeSingle();
  const tier = Number(data?.trust_tier);
  if (!Number.isFinite(tier)) return 4;
  return Math.min(5, Math.max(1, tier));
}
