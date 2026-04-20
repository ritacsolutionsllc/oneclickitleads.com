/**
 * Quality-first scoring engine.
 *
 * One canonical scoring path for every ingestion route. Given a scrubbed
 * lead + the source tier + ICP signals, returns:
 *
 *   - quality_score        0-100, deterministic, explainable
 *   - verification_status  ladder: unverified -> syntax -> mx -> smtp / first_party
 *   - export_eligibility   eligible | review | quarantined | rejected
 *   - reason_codes         machine-readable explanations for the UI
 *   - review_state         workflow state (new / reverify / approved)
 *
 * Defaults are intentionally pessimistic. A row that never makes it
 * through this engine stays `quarantined` and cannot be exported.
 */

import type { ScrubbedLead } from '@/utils/scrub/pipeline';
import { tierForSourceKind, type SourceTier } from './source-tier';

export type VerificationStatus =
  | 'unverified'
  | 'syntax_only'
  | 'mx_valid'
  | 'smtp_verified'
  | 'first_party';

export type ExportEligibility = 'eligible' | 'review' | 'quarantined' | 'rejected';
export type ReviewState = 'new' | 'in_review' | 'approved' | 'discarded' | 'reverify';

export type ReasonCode =
  // verification ladder
  | 'smtp_verified'
  | 'mx_verified'
  | 'syntax_only'
  | 'no_mx'
  | 'smtp_failed'
  | 'no_email'
  | 'bad_syntax'
  | 'disposable_domain'
  // pipeline outcomes
  | 'duplicate'
  | 'suppressed'
  // source confidence
  | 'first_party_purchaser'
  | 'verified_directory_signal'
  | 'public_scraped_unverified'
  | 'purchased_list_review'
  | 'unknown_source'
  // ICP / completeness
  | 'icp_match'
  | 'icp_unset'
  | 'incomplete_profile'
  | 'high_review_signal'
  | 'low_review_signal'
  // freshness
  | 'fresh'
  | 'stale_record';

const KNOWN_ICP_SEGMENTS = new Set([
  'b2c_beauty',
  'salon',
  'retailer',
  'influencer',
]);

const STALE_AFTER_DAYS = 90;
const FRESH_WITHIN_DAYS = 30;

export interface QualitySignals {
  /** Optional rating signal (Google Places). */
  rating?: number | null;
  /** Optional rating count signal (Google Places). */
  rating_count?: number | null;
  /** When was this record last verified by us, if ever. */
  verified_at?: string | Date | null;
  /** Override: caller already knows this is first-party data. */
  first_party?: boolean;
}

export interface QualityResult {
  quality_score: number;            // 0..100
  verification_status: VerificationStatus;
  source_tier: SourceTier;
  export_eligibility: ExportEligibility;
  reason_codes: ReasonCode[];
  review_state: ReviewState;
  verified_at: string;              // ISO timestamp set by this run
  computed_at: string;              // ISO timestamp set by this run
}

export interface ScoreInputs {
  scrubbed: ScrubbedLead;
  sourceKind?: string | null;
  sourceTier?: SourceTier;
  signals?: QualitySignals;
}

/**
 * The single canonical scoring entry point. Every ingest path calls this.
 *
 * Score breakdown (capped at 100):
 *   verification    up to 45 pts   (smtp 45 / mx 30 / syntax 10 / none 0)
 *   source tier     up to 25 pts   (first-party 25 / directory 18 / enriched 14 / scraped 6 / purchased 4)
 *   completeness    up to 15 pts   (name + phone + company + geo + title)
 *   icp fit         up to 10 pts   (known segment 10 / unset 0)
 *   freshness       up to 5  pts   (verified within 30d 5 / 31-90d 2 / older 0)
 *   directory boost up to 5  pts   (Google rating * count proxy)
 *   penalties       -100 pts       (suppressed / duplicate / disposable / no email -> rejected)
 */
export function scoreLead(inputs: ScoreInputs): QualityResult {
  const { scrubbed, sourceKind, sourceTier: tierOverride, signals } = inputs;
  const reasons: ReasonCode[] = [];
  const tier: SourceTier = tierOverride ?? tierForSourceKind(sourceKind);

  // ---------------- Hard rejections -----------------
  if (scrubbed.is_suppressed) {
    reasons.push('suppressed');
    return finalize({
      quality_score: 0,
      verification_status: verificationFromScrub(scrubbed, signals),
      source_tier: tier,
      export_eligibility: 'rejected',
      reason_codes: reasons,
      review_state: 'discarded',
    });
  }
  if (scrubbed.is_duplicate) {
    reasons.push('duplicate');
    return finalize({
      quality_score: 0,
      verification_status: verificationFromScrub(scrubbed, signals),
      source_tier: tier,
      export_eligibility: 'rejected',
      reason_codes: reasons,
      review_state: 'discarded',
    });
  }
  if (scrubbed.is_disposable) {
    reasons.push('disposable_domain');
    return finalize({
      quality_score: 0,
      verification_status: 'unverified',
      source_tier: tier,
      export_eligibility: 'rejected',
      reason_codes: reasons,
      review_state: 'discarded',
    });
  }

  // ---------------- Verification ladder + points ----
  const verification = verificationFromScrub(scrubbed, signals);
  let score = 0;

  switch (verification) {
    case 'smtp_verified':
      score += 45;
      reasons.push('smtp_verified');
      break;
    case 'mx_valid':
      score += 30;
      reasons.push('mx_verified');
      break;
    case 'first_party':
      score += 45;
      reasons.push('first_party_purchaser');
      break;
    case 'syntax_only':
      score += 10;
      reasons.push('syntax_only');
      break;
    case 'unverified':
      // No email at all OR failed syntax — could still be a phone-only lead.
      if (!scrubbed.normalized_email) reasons.push('no_email');
      else if (!scrubbed.syntax_valid) reasons.push('bad_syntax');
      else if (!scrubbed.mx_valid) reasons.push('no_mx');
      else reasons.push('smtp_failed');
      break;
  }

  // ---------------- Source tier points --------------
  switch (tier) {
    case 'first_party':
      score += 25;
      if (!reasons.includes('first_party_purchaser')) reasons.push('first_party_purchaser');
      break;
    case 'verified_directory':
      score += 18;
      reasons.push('verified_directory_signal');
      break;
    case 'enriched':
      score += 14;
      break;
    case 'scraped':
      score += 6;
      reasons.push('public_scraped_unverified');
      break;
    case 'purchased':
      score += 4;
      reasons.push('purchased_list_review');
      break;
    case 'unknown':
      reasons.push('unknown_source');
      break;
  }

  // ---------------- Completeness --------------------
  const completeness = completenessPoints(scrubbed);
  score += completeness.points;
  if (completeness.points <= 4) reasons.push('incomplete_profile');

  // ---------------- ICP fit -------------------------
  const icp = (scrubbed.icp_segment ?? '').toString().toLowerCase();
  if (icp && KNOWN_ICP_SEGMENTS.has(icp)) {
    score += 10;
    reasons.push('icp_match');
  } else {
    reasons.push('icp_unset');
  }

  // ---------------- Freshness -----------------------
  const freshness = freshnessPoints(signals?.verified_at);
  score += freshness.points;
  if (freshness.code) reasons.push(freshness.code);

  // ---------------- Directory boost (Google) --------
  const directoryBoost = directoryBoostPoints(signals);
  score += directoryBoost.points;
  if (directoryBoost.code) reasons.push(directoryBoost.code);

  // Clamp + decide eligibility
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const eligibility = decideEligibility({
    score: clamped,
    verification,
    tier,
    hasContact: Boolean(scrubbed.normalized_email || scrubbed.phone_e164),
  });

  const reviewState: ReviewState =
    eligibility === 'eligible' ? 'approved' :
    eligibility === 'review'   ? 'in_review' :
    eligibility === 'rejected' ? 'discarded' :
    'new';

  return finalize({
    quality_score: clamped,
    verification_status: verification,
    source_tier: tier,
    export_eligibility: eligibility,
    reason_codes: dedupe(reasons),
    review_state: reviewState,
  });
}

// ---------- helpers ----------

function verificationFromScrub(
  scrubbed: ScrubbedLead,
  signals: QualitySignals | undefined,
): VerificationStatus {
  if (signals?.first_party) return 'first_party';
  if (!scrubbed.normalized_email) return 'unverified';
  if (scrubbed.smtp_valid) return 'smtp_verified';
  if (scrubbed.mx_valid)   return 'mx_valid';
  if (scrubbed.syntax_valid) return 'syntax_only';
  return 'unverified';
}

function completenessPoints(scrubbed: ScrubbedLead): { points: number } {
  let p = 0;
  if (scrubbed.first_name || scrubbed.last_name) p += 3;
  if (scrubbed.phone_e164) p += 3;
  if (scrubbed.company)    p += 3;
  if (scrubbed.title)      p += 2;
  if (scrubbed.city || scrubbed.region || scrubbed.country) p += 4;
  return { points: Math.min(15, p) };
}

function freshnessPoints(verifiedAt: string | Date | null | undefined):
  { points: number; code?: ReasonCode } {
  if (!verifiedAt) return { points: 0 };
  const t = typeof verifiedAt === 'string' ? Date.parse(verifiedAt) : verifiedAt.getTime();
  if (Number.isNaN(t)) return { points: 0 };
  const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (ageDays <= FRESH_WITHIN_DAYS) return { points: 5, code: 'fresh' };
  if (ageDays <= STALE_AFTER_DAYS)  return { points: 2 };
  return { points: 0, code: 'stale_record' };
}

function directoryBoostPoints(signals: QualitySignals | undefined):
  { points: number; code?: ReasonCode } {
  const rating = Number(signals?.rating ?? 0);
  const count  = Number(signals?.rating_count ?? 0);
  if (!rating || !count) return { points: 0 };
  // Salons with 4.7★ × 200 reviews are night-and-day better than 3.0 × 5.
  const proxy = (rating * count) / 100;       // matches existing lead_quality_score formula
  if (proxy >= 20)  return { points: 5, code: 'high_review_signal' };
  if (proxy >= 5)   return { points: 3 };
  if (proxy > 0)    return { points: 1, code: 'low_review_signal' };
  return { points: 0 };
}

function decideEligibility(args: {
  score: number;
  verification: VerificationStatus;
  tier: SourceTier;
  hasContact: boolean;
}): ExportEligibility {
  if (!args.hasContact) return 'rejected';

  // First-party data is always export-eligible (it's our customer's
  // own purchasers, suppression list lives separately).
  if (args.verification === 'first_party') return 'eligible';

  // SMTP-verified emails clear the bar at any score >= 60.
  if (args.verification === 'smtp_verified' && args.score >= 60) return 'eligible';

  // MX-valid + a high-confidence directory or enriched source is OK to
  // export but stays behind the lower-tier review fence on purchased data.
  if (
    args.verification === 'mx_valid' &&
    args.score >= 70 &&
    (args.tier === 'verified_directory' || args.tier === 'enriched')
  ) {
    return 'eligible';
  }

  // Public scraped sources NEVER bypass the gate without independent
  // verification — this is the rule the rest of the platform inherits.
  if (args.tier === 'scraped' || args.tier === 'unknown') {
    return args.score >= 40 ? 'review' : 'quarantined';
  }
  if (args.tier === 'purchased') {
    return args.score >= 50 ? 'review' : 'quarantined';
  }

  return args.score >= 50 ? 'review' : 'quarantined';
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function finalize(
  partial: Omit<QualityResult, 'verified_at' | 'computed_at'>,
): QualityResult {
  const now = new Date().toISOString();
  return {
    ...partial,
    verified_at: now,
    computed_at: now,
  };
}

/**
 * Convenience: returns the DB column payload for a single scored lead so
 * each ingestion route can spread it onto its insert without re-deriving
 * field names. Keeps the schema contract centralized.
 */
export function qualityColumns(result: QualityResult) {
  return {
    quality_score:        result.quality_score,
    verification_status:  result.verification_status,
    source_tier:          result.source_tier,
    export_eligibility:   result.export_eligibility,
    reason_codes:         result.reason_codes,
    review_state:         result.review_state,
    verified_at:          result.verified_at,
    quality_computed_at:  result.computed_at,
  };
}
