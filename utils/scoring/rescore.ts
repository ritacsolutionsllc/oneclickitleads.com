// Re-score an already-persisted lead.
//
// The scrub pipeline runs once at ingest time. After that, lead rows get
// mutated by /api/enrich (Hunter.io domain-search fills missing email) and
// /api/harvest-emails (scrapes site contact pages). Before this helper
// existed, those routes updated `email` / `first_name` / `title` but left
// the composite score, export_tier, verified_at, and reason_codes frozen
// at their original values — so a lead that was ingested with only a phone
// number stayed in the `hold` tier forever even after an email got filled.
//
// `rescoreLead` takes a minimal row shape (whatever columns you SELECTed
// from `leads`) plus any freshly-enriched fields, recomputes the six
// sub-scores + tier + reason codes, and returns the Supabase update
// payload. `composite_score` is intentionally omitted — it's a stored
// generated column and rejects explicit writes.

import { scoreLead, type ScoreInput } from './score';
import { assignTier, type ExportPolicy, type ExportTier } from './tier';

/** Columns rescoreLead reads. SELECT these from `leads`. */
export interface RescoreRow {
  email?: string | null;
  phone_e164?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  linkedin_url?: string | null;
  instagram_handle?: string | null;
  icp_segment?: string | null;
  syntax_valid?: boolean | null;
  mx_valid?: boolean | null;
  smtp_valid?: boolean | null;
  is_disposable?: boolean | null;
  is_duplicate?: boolean | null;
  is_suppressed?: boolean | null;
  is_scrubbed?: boolean | null;
  verified_at?: string | null;
}

export interface RescoreOptions {
  /** Who/what triggered the rescore — written to `verified_by`. */
  verifiedBy: string;
  /** 1..5 (best..worst). Falls through to the current source's tier. */
  sourceTrustTier?: number | null;
  /** Client's ICP targets for the ICP-fit sub-score. */
  clientIcpTargets?: string[] | null;
  /** Client's export_policy for the tier floor. */
  exportPolicy?: ExportPolicy | null;
  /**
   * Mark the rescore as a fresh external verification. When true,
   * `verified_at` is bumped to now. When false, the existing verified_at
   * is preserved so the freshness score keeps aging correctly (use for
   * purely structural re-runs like a weights change).
   */
  bumpVerifiedAt?: boolean;
}

export interface RescoreResult {
  identity_score: number;
  icp_fit_score: number;
  completeness_score: number;
  freshness_score: number;
  intent_score: number;
  source_confidence: number;
  export_tier: ExportTier;
  verified_at: string;
  verified_by: string;
  reason_codes: string[];
  last_rescored_at: string;
}

/**
 * Pure: given a lead row and options, return the columns to UPDATE.
 * Caller is responsible for the actual `supabase.from('leads').update(...)`.
 */
export function rescoreLead(row: RescoreRow, opts: RescoreOptions): RescoreResult {
  const now = new Date().toISOString();
  const verified_at =
    opts.bumpVerifiedAt === false && row.verified_at ? row.verified_at : now;

  const input: ScoreInput = {
    syntax_valid: row.syntax_valid ?? undefined,
    mx_valid: row.mx_valid ?? undefined,
    smtp_valid: row.smtp_valid ?? undefined,
    is_disposable: row.is_disposable ?? undefined,
    is_duplicate: row.is_duplicate ?? undefined,
    is_suppressed: row.is_suppressed ?? undefined,
    email: row.email,
    phone_e164: row.phone_e164,
    first_name: row.first_name,
    last_name: row.last_name,
    company: row.company,
    title: row.title,
    city: row.city,
    region: row.region,
    country: row.country,
    linkedin_url: row.linkedin_url,
    instagram_handle: row.instagram_handle,
    icp_segment: row.icp_segment,
    client_icp_targets: opts.clientIcpTargets ?? null,
    // verified_at drives the freshness sub-score; use the row's historical
    // value so the score decays correctly over time.
    verified_at: row.verified_at ?? null,
    source_trust_tier: opts.sourceTrustTier ?? null,
  };

  const scores = scoreLead(input);
  const export_tier = assignTier({
    composite_score: scores.composite_score,
    is_suppressed: !!row.is_suppressed,
    is_duplicate: !!row.is_duplicate,
    is_scrubbed: row.is_scrubbed !== false,
    policy: opts.exportPolicy ?? null,
  });

  return {
    identity_score: scores.identity_score,
    icp_fit_score: scores.icp_fit_score,
    completeness_score: scores.completeness_score,
    freshness_score: scores.freshness_score,
    intent_score: scores.intent_score,
    source_confidence: scores.source_confidence,
    export_tier,
    verified_at,
    verified_by: opts.verifiedBy,
    reason_codes: scores.reason_codes,
    last_rescored_at: now,
  };
}
