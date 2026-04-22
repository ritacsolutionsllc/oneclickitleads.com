// Re-score a lead that already exists in the DB, after a mutation that
// could change identity/completeness (e.g. /api/harvest-emails fills in an
// email, /api/enrich fills in name/title). Centralises the read → score →
// tier → review_state flow so callers can't drift from the scrub pipeline.
//
// Callers pass the lead id; this fetches the row, recomputes sub-scores,
// reassigns the export tier and review_state, and writes everything back
// atomically. composite_score is intentionally not written — it's a stored
// generated column in the DB.

import type { SupabaseClient } from '@supabase/supabase-js';
import { scoreLead, type ScoreInput } from './score';
import {
  assignTier,
  assignReviewState,
  type ExportPolicy,
  type ExportTier,
  type ReviewState,
} from './tier';

interface LeadRowForRescore {
  id: string;
  client_id: string;
  email: string | null;
  phone_e164: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  linkedin_url: string | null;
  instagram_handle: string | null;
  icp_segment: string | null;
  syntax_valid: boolean | null;
  mx_valid: boolean | null;
  smtp_valid: boolean | null;
  is_disposable: boolean | null;
  is_duplicate: boolean | null;
  is_suppressed: boolean | null;
  is_scrubbed: boolean | null;
  source_id: string | null;
  verified_at: string | null;
}

interface ClientPolicyRow {
  export_policy: ExportPolicy | null;
}

interface SourceRow {
  trust_tier: number | null;
}

export interface RescoreResult {
  lead_id: string;
  composite_score: number;
  export_tier: ExportTier;
  review_state: ReviewState | null;
}

/**
 * Re-score a single lead by id. Returns the new tier + review_state, or
 * `null` if the lead can't be found. The caller is expected to use an
 * admin client because cron jobs and harvesters run server-side.
 *
 * `freshness`: 'reset' (default) treats this re-score as a verification
 * event and resets the freshness clock to today. 'preserve' uses the row's
 * existing verified_at — appropriate when callers are only fixing data
 * shape (e.g. backfills) without re-verifying anything.
 */
export async function rescoreLeadById(
  supabase: SupabaseClient,
  leadId: string,
  opts: { verifiedBy?: string; freshness?: 'reset' | 'preserve' } = {}
): Promise<RescoreResult | null> {
  const { data: lead } = await supabase
    .from('leads')
    .select(
      'id, client_id, email, phone_e164, first_name, last_name, company, title, city, region, country, linkedin_url, instagram_handle, icp_segment, syntax_valid, mx_valid, smtp_valid, is_disposable, is_duplicate, is_suppressed, is_scrubbed, source_id, verified_at'
    )
    .eq('id', leadId)
    .maybeSingle<LeadRowForRescore>();
  if (!lead) return null;

  const [{ data: client }, { data: src }] = await Promise.all([
    supabase
      .from('clients')
      .select('export_policy')
      .eq('id', lead.client_id)
      .maybeSingle<ClientPolicyRow>(),
    lead.source_id
      ? supabase
          .from('sources')
          .select('trust_tier')
          .eq('id', lead.source_id)
          .maybeSingle<SourceRow>()
      : Promise.resolve({ data: null as SourceRow | null }),
  ]);

  const scoreInput: ScoreInput = {
    syntax_valid: lead.syntax_valid ?? undefined,
    mx_valid: lead.mx_valid ?? undefined,
    smtp_valid: lead.smtp_valid ?? undefined,
    is_disposable: lead.is_disposable ?? undefined,
    is_duplicate: lead.is_duplicate ?? undefined,
    is_suppressed: lead.is_suppressed ?? undefined,
    email: lead.email,
    phone_e164: lead.phone_e164,
    first_name: lead.first_name,
    last_name: lead.last_name,
    company: lead.company,
    title: lead.title,
    city: lead.city,
    region: lead.region,
    country: lead.country,
    linkedin_url: lead.linkedin_url,
    instagram_handle: lead.instagram_handle,
    icp_segment: lead.icp_segment,
    // ICP targets aren't stored on clients yet — scoreIcpFit defaults to
    // neutral (0.5) when targets are unknown, matching the scrub pipeline.
    client_icp_targets: null,
    verified_at: opts.freshness === 'preserve' ? lead.verified_at : null,
    source_trust_tier: src?.trust_tier ?? null,
  };

  const scores = scoreLead(scoreInput);
  const export_tier = assignTier({
    composite_score: scores.composite_score,
    is_suppressed: !!lead.is_suppressed,
    is_duplicate: !!lead.is_duplicate,
    is_scrubbed: !!lead.is_scrubbed,
    policy: client?.export_policy ?? null,
  });
  const review_state = assignReviewState({
    tier: export_tier,
    is_suppressed: !!lead.is_suppressed,
    is_duplicate: !!lead.is_duplicate,
    is_scrubbed: !!lead.is_scrubbed,
  });

  // Only stamp review_state when this is a new auto-pending. Don't clobber
  // an operator decision (approved/rejected/quarantined/reverify) just
  // because completeness changed.
  const updates: Record<string, unknown> = {
    identity_score: scores.identity_score,
    icp_fit_score: scores.icp_fit_score,
    completeness_score: scores.completeness_score,
    freshness_score: scores.freshness_score,
    intent_score: scores.intent_score,
    source_confidence: scores.source_confidence,
    export_tier,
    verified_at: new Date().toISOString(),
    verified_by: opts.verifiedBy ?? 'rescore',
  };

  // Stamp pending only if not already in the queue (operator decisions
  // survive). When the lead climbs out of review/hold, clear the pending.
  if (review_state === 'pending') {
    updates.review_state = 'pending';
  } else if (review_state === null) {
    // Lead is now auto-export or auto-discard; only clear an auto-pending,
    // not an operator decision.
    const { data: current } = await supabase
      .from('leads')
      .select('review_state')
      .eq('id', leadId)
      .maybeSingle<{ review_state: ReviewState | null }>();
    if (current?.review_state === 'pending') updates.review_state = null;
  }

  await supabase.from('leads').update(updates).eq('id', leadId);

  return {
    lead_id: leadId,
    composite_score: scores.composite_score,
    export_tier,
    review_state,
  };
}
