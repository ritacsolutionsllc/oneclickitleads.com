// Re-score an existing lead row.
//
// Used by enrichment paths that mutate a lead in place (harvest-emails,
// /api/enrich, the nightly re-verify edge function) so the composite score,
// export_tier, review_state, and reason_codes stay in sync with the new
// field values. composite_score is a generated column and is recomputed by
// the DB; this helper writes the sub-scores it depends on.

import type { SupabaseClient } from '@supabase/supabase-js';
import { scoreLead } from './score';
import { assignTier, defaultReviewState } from './tier';
import { reasonCodesFor } from './reason-codes';
import { loadClientScoringContext } from './client-context';
import { trustTierForSource } from './sources';

export interface RescoreOptions {
  /** Override the source trust tier (default: looked up from sources.kind / trust_tier). */
  sourceTrustTier?: number;
  /** What changed: stamped into verified_by for audit (e.g. 'harvest-emails', 'hunter-enrich'). */
  verifiedBy?: string;
  /** Touch verified_at to now (default true). False is useful when the trigger isn't a verification. */
  touchVerifiedAt?: boolean;
}

interface LeadRow {
  id: string;
  client_id: string;
  source_id: string | null;
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
  verified_at: string | null;
  review_state: string | null;
}

interface SourceRow {
  kind: string | null;
  trust_tier: number | null;
}

/**
 * Recompute every score field for a single lead and persist the result.
 * Returns the updated scoring fields, or null if the lead can't be loaded.
 *
 * Won't overwrite an `approved` or `rejected` review_state — operator
 * decisions stick. New review_state is only written for auto/queue rows.
 */
export async function rescoreLead(
  supabase: SupabaseClient,
  leadId: string,
  opts: RescoreOptions = {}
) {
  const { data: lead } = await supabase
    .from('leads')
    .select(
      'id, client_id, source_id, email, phone_e164, first_name, last_name, company, title, city, region, country, linkedin_url, instagram_handle, icp_segment, syntax_valid, mx_valid, smtp_valid, is_disposable, is_duplicate, is_suppressed, is_scrubbed, verified_at, review_state'
    )
    .eq('id', leadId)
    .maybeSingle<LeadRow>();
  if (!lead) return null;

  const ctx = await loadClientScoringContext(supabase, lead.client_id);

  let sourceTrustTier = opts.sourceTrustTier;
  if (sourceTrustTier == null && lead.source_id) {
    const { data: src } = await supabase
      .from('sources')
      .select('kind, trust_tier')
      .eq('id', lead.source_id)
      .maybeSingle<SourceRow>();
    if (src) {
      sourceTrustTier = src.trust_tier ?? trustTierForSource(src.kind ?? undefined);
    }
  }
  if (sourceTrustTier == null) sourceTrustTier = 4;

  const scoreInput = {
    syntax_valid: lead.syntax_valid ?? undefined,
    mx_valid: lead.mx_valid ?? undefined,
    smtp_valid: lead.smtp_valid ?? undefined,
    is_disposable: lead.is_disposable ?? undefined,
    is_duplicate: lead.is_duplicate ?? false,
    is_suppressed: lead.is_suppressed ?? false,
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
    client_icp_targets: ctx?.icpTargets ?? null,
    verified_at: lead.verified_at,
    source_trust_tier: sourceTrustTier,
  };
  const scores = scoreLead(scoreInput);

  const tier = assignTier({
    composite_score: scores.composite_score,
    is_suppressed: !!lead.is_suppressed,
    is_duplicate: !!lead.is_duplicate,
    is_scrubbed: !!lead.is_scrubbed,
    policy: ctx?.exportPolicy ?? null,
  });

  const codes = reasonCodesFor(
    { ...scoreInput, email_clean: !!lead.is_scrubbed },
    scores
  );

  const isOperatorLocked =
    lead.review_state === 'approved' || lead.review_state === 'rejected';

  const update: Record<string, unknown> = {
    identity_score: scores.identity_score,
    icp_fit_score: scores.icp_fit_score,
    completeness_score: scores.completeness_score,
    freshness_score: scores.freshness_score,
    intent_score: scores.intent_score,
    source_confidence: scores.source_confidence,
    export_tier: tier,
    reason_codes: codes,
  };

  if (!isOperatorLocked) {
    update.review_state = defaultReviewState({
      tier,
      is_suppressed: !!lead.is_suppressed,
      is_duplicate: !!lead.is_duplicate,
      is_scrubbed: !!lead.is_scrubbed,
      policy: ctx?.exportPolicy ?? null,
    });
  }

  if (opts.touchVerifiedAt !== false) {
    update.verified_at = new Date().toISOString();
    update.verified_by = opts.verifiedBy ?? 'rescore';
  }

  const { error } = await supabase.from('leads').update(update).eq('id', leadId);
  if (error) throw error;
  return { scores, export_tier: tier, reason_codes: codes };
}
