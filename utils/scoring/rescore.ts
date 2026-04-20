// Re-score an existing lead in place. Used by routes that update a lead's
// fields post-scrub (enrichment fills in an email, harvest-emails finds a
// mailto on the homepage) — any time the inputs to scoreLead change, the
// stored sub-scores + export_tier must be refreshed or the DB drifts and
// the tier/quality dashboard lies.
//
// This helper is intentionally read-then-write so callers don't have to
// rebuild the ScoreInput themselves. It respects suppressions + dedupe
// state that's already on the row.

import type { SupabaseClient } from '@supabase/supabase-js';
import { scoreLead } from './score';
import { assignTier, type ExportPolicy } from './tier';

interface LeadRow {
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
  verified_at: string | null;
  source_id: string | null;
}

interface ClientPolicy {
  id: string;
  export_policy: ExportPolicy | null;
}

export interface RescoreResult {
  id: string;
  composite_score: number;
  export_tier: string;
  updated: boolean;
}

/**
 * Recompute all sub-scores + export_tier for a single lead and write them
 * back. Returns the new composite + tier. `composite_score` is a generated
 * column in Postgres, so it's not written — we return the JS-side value
 * that mirrors what the DB will compute from the sub-scores.
 */
export async function rescoreLead(
  supabase: SupabaseClient,
  leadId: string,
  opts: {
    /** Force-set verified_at; otherwise keep whatever is already on the row. */
    verifiedAt?: string | null;
    verifiedBy?: string;
  } = {}
): Promise<RescoreResult | null> {
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select(
      'id, client_id, email, phone_e164, first_name, last_name, company, title, city, region, country, linkedin_url, instagram_handle, icp_segment, syntax_valid, mx_valid, smtp_valid, is_disposable, is_duplicate, is_suppressed, is_scrubbed, verified_at, source_id'
    )
    .eq('id', leadId)
    .maybeSingle<LeadRow>();
  if (leadErr || !lead) return null;

  const [{ data: client }, { data: source }] = await Promise.all([
    supabase
      .from('clients')
      .select('id, export_policy')
      .eq('id', lead.client_id)
      .maybeSingle<ClientPolicy>(),
    lead.source_id
      ? supabase
          .from('sources')
          .select('trust_tier')
          .eq('id', lead.source_id)
          .maybeSingle<{ trust_tier: number | null }>()
      : Promise.resolve({ data: null }),
  ]);

  const scores = scoreLead({
    syntax_valid: !!lead.syntax_valid,
    mx_valid: !!lead.mx_valid,
    smtp_valid: !!lead.smtp_valid,
    is_disposable: !!lead.is_disposable,
    is_duplicate: !!lead.is_duplicate,
    is_suppressed: !!lead.is_suppressed,
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
    // icp_targets isn't a column on clients yet — scorer treats null as
    // neutral (0.5) and keeps behaviour identical to first-scrub.
    client_icp_targets: null,
    verified_at: opts.verifiedAt ?? lead.verified_at ?? null,
    source_trust_tier: source?.trust_tier ?? null,
  });

  const export_tier = assignTier({
    composite_score: scores.composite_score,
    is_suppressed: !!lead.is_suppressed,
    is_duplicate: !!lead.is_duplicate,
    is_scrubbed: !!lead.is_scrubbed,
    policy: client?.export_policy ?? null,
  });

  const update: Record<string, unknown> = {
    identity_score: scores.identity_score,
    icp_fit_score: scores.icp_fit_score,
    completeness_score: scores.completeness_score,
    freshness_score: scores.freshness_score,
    intent_score: scores.intent_score,
    source_confidence: scores.source_confidence,
    export_tier,
  };
  if (opts.verifiedAt !== undefined) update.verified_at = opts.verifiedAt;
  if (opts.verifiedBy) update.verified_by = opts.verifiedBy;

  const { error: updErr } = await supabase.from('leads').update(update).eq('id', leadId);

  return {
    id: leadId,
    composite_score: scores.composite_score,
    export_tier,
    updated: !updErr,
  };
}
