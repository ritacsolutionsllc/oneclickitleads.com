// Rescore a lead after an out-of-band mutation (enrichment, email harvest,
// reverify, operator edit). Keeps sub-scores + export_tier in sync with the
// row's current state so downstream export gating is truthful.
//
// Without this helper, /api/enrich and /api/harvest-emails can attach a new
// email/name to a lead that was previously in `hold` or `review` — the lead
// now satisfies export rules but its export_tier still says otherwise, so it
// silently stays quarantined.

import type { SupabaseClient } from '@supabase/supabase-js';
import { scoreLead } from './score';
import { assignTier } from './tier';
import { loadClientScoringContextById } from './context';

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
}

export interface RescoreOptions {
  /** If the caller just re-verified the email, pass the provider tag
   *  (e.g. `'harvest-emails'`, `'neverbounce:valid'`) to refresh `verified_at`. */
  verifiedBy?: string;
  /** Force is_scrubbed on/off. Default: keep existing value. */
  setIsScrubbed?: boolean;
}

export interface RescoreResult {
  ok: boolean;
  error?: string;
  composite_score?: number;
  export_tier?: string;
}

export async function rescoreLead(
  supabase: SupabaseClient,
  leadId: string,
  opts: RescoreOptions = {}
): Promise<RescoreResult> {
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select(
      'id, client_id, source_id, email, phone_e164, first_name, last_name, ' +
        'company, title, city, region, country, linkedin_url, instagram_handle, ' +
        'icp_segment, syntax_valid, mx_valid, smtp_valid, is_disposable, ' +
        'is_duplicate, is_suppressed, is_scrubbed, verified_at'
    )
    .eq('id', leadId)
    .single<LeadRow>();
  if (leadErr || !lead) return { ok: false, error: leadErr?.message ?? 'lead not found' };

  const ctx = await loadClientScoringContextById(supabase, lead.client_id);
  if (!ctx) return { ok: false, error: 'client not found' };

  // Source trust tier drives source_confidence. Defaults to 4 (public-scraped)
  // when unknown — same as the scrub pipeline.
  let sourceTrustTier = 4;
  if (lead.source_id) {
    const { data: src } = await supabase
      .from('sources')
      .select('trust_tier')
      .eq('id', lead.source_id)
      .single<{ trust_tier: number | null }>();
    if (src?.trust_tier != null) sourceTrustTier = src.trust_tier;
  }

  const scores = scoreLead({
    syntax_valid: lead.syntax_valid ?? false,
    mx_valid: lead.mx_valid ?? false,
    smtp_valid: lead.smtp_valid ?? false,
    is_disposable: lead.is_disposable ?? false,
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
    client_icp_targets: ctx.icpTargets,
    verified_at: opts.verifiedBy ? null : lead.verified_at,
    source_trust_tier: sourceTrustTier,
  });

  const nextScrubbed =
    opts.setIsScrubbed !== undefined ? opts.setIsScrubbed : !!lead.is_scrubbed;

  const export_tier = assignTier({
    composite_score: scores.composite_score,
    is_suppressed: !!lead.is_suppressed,
    is_duplicate: !!lead.is_duplicate,
    is_scrubbed: nextScrubbed,
    policy: ctx.exportPolicy,
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
  if (opts.setIsScrubbed !== undefined) update.is_scrubbed = nextScrubbed;
  if (opts.verifiedBy) {
    update.verified_at = new Date().toISOString();
    update.verified_by = opts.verifiedBy;
  }

  const { error: updErr } = await supabase.from('leads').update(update).eq('id', leadId);
  if (updErr) return { ok: false, error: updErr.message };

  return { ok: true, composite_score: scores.composite_score, export_tier };
}
