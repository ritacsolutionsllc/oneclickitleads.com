/**
 * Deterministic lead quality engine.
 *
 * Single canonical path that every ingest/enrich/import route runs through
 * before persisting a row. Route handlers stay thin: build a `QualityInput`,
 * call `scoreLead`, and write the `QualityOutput` onto the insert payload.
 *
 * Philosophy
 * ----------
 * A lead is three things:
 *   1. An identity signal (does the email/phone actually exist?)
 *   2. A fit signal (is it plausibly the client's ICP?)
 *   3. A source signal (how much do we trust where it came from?)
 *
 * Export eligibility = verified identity + non-zero fit + source trust
 * meets the bar for its tier. Everything else goes to the review queue
 * with an explicit reason code set.
 */

import { sourceKindToTier, type SourceTier } from './source-tiers';

export type QualityTier = 'gold' | 'silver' | 'bronze' | 'review' | 'rejected';

export type VerificationStatus =
  | 'verified'       // syntax + MX + SMTP ok (or first-party)
  | 'unverified'     // syntax + MX ok, SMTP unknown
  | 'failed'         // disposable / no-MX / SMTP hard fail
  | 'pending';       // not yet scrubbed

export type ReviewState =
  | 'none'          // export_eligible==true or rejected outright
  | 'pending'       // borderline — operator should look
  | 'quarantined'   // risky (scraped + unverified + low completeness)
  | 'approved'      // operator override → treat as eligible
  | 'rejected';     // operator override → never export

/**
 * Reason codes describe *why* a score is what it is. Keep them short,
 * machine-readable, and stable — the dashboard and future audit tools key
 * on them.
 */
export type ReasonCode =
  // identity
  | 'email_verified'
  | 'email_mx_only'
  | 'email_missing'
  | 'email_syntax_invalid'
  | 'email_disposable'
  | 'email_no_mx'
  | 'email_smtp_failed'
  | 'phone_present'
  | 'phone_missing'
  // completeness
  | 'name_present'
  | 'company_present'
  | 'location_present'
  | 'completeness_low'
  // fit
  | 'icp_match'
  | 'icp_missing'
  // source
  | 'source_tier_1_firstparty'
  | 'source_tier_2_verified'
  | 'source_tier_3_scraped'
  | 'source_unknown'
  // gate outcomes
  | 'suppressed'
  | 'duplicate'
  | 'scraped_without_verification'
  | 'stale'
  | 'below_export_threshold'
  | 'manual_override_approved'
  | 'manual_override_rejected';

export interface QualityInput {
  // identity signals (from scrub pipeline or first-party import)
  email?: string | null;
  phone_e164?: string | null;
  syntax_valid?: boolean | null;
  mx_valid?: boolean | null;
  smtp_valid?: boolean | null;
  is_disposable?: boolean | null;
  is_duplicate?: boolean | null;
  is_suppressed?: boolean | null;

  // completeness signals
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;

  // fit
  icp_segment?: string | null;

  // freshness — when the signal was collected (defaults to now)
  observed_at?: Date | string | null;

  // source
  source_kind?: string | null;             // 'firstparty' | 'apollo' | 'scraped' | ...
  source_tier?: SourceTier | null;         // overrides source_kind if provided
}

export interface QualityOutput {
  quality_score: number;                   // 0..100
  quality_tier: QualityTier;
  verification_status: VerificationStatus;
  verified_at: string | null;              // ISO string if verified, else null
  source_tier: SourceTier;
  export_eligible: boolean;
  export_blocked_reason: string | null;    // single-line summary for audit
  reason_codes: ReasonCode[];
  icp_fit_score: number;                   // 0..100
  review_state: ReviewState;
  quality_scored_at: string;               // ISO now
}

/** Known ICP segments for Chella's beauty/IT lead program. */
const KNOWN_ICP_SEGMENTS = new Set([
  'b2c_beauty',
  'salon',
  'retailer',
  'influencer',
]);

const FRESH_WINDOW_DAYS = 30;

function clamp(n: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function hasText(v: string | null | undefined): v is string {
  return !!v && v.trim().length > 0;
}

function daysSince(when: Date | string | null | undefined): number {
  if (!when) return 0;
  const t = typeof when === 'string' ? Date.parse(when) : when.getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

/**
 * Pure, deterministic: same input always produces same output. No I/O.
 */
export function scoreLead(input: QualityInput): QualityOutput {
  const reasons: ReasonCode[] = [];

  // --- Source tier (resolved from explicit override or source kind) ---
  const resolvedSourceTier: SourceTier =
    input.source_tier ??
    (input.source_kind ? sourceKindToTier(input.source_kind) : 'tier3');

  switch (resolvedSourceTier) {
    case 'tier1': reasons.push('source_tier_1_firstparty'); break;
    case 'tier2': reasons.push('source_tier_2_verified'); break;
    case 'tier3': reasons.push('source_tier_3_scraped'); break;
  }
  if (!input.source_kind && !input.source_tier) reasons.push('source_unknown');

  // --- Identity / verification ---
  let identityPoints = 0;
  let verificationStatus: VerificationStatus;

  if (resolvedSourceTier === 'tier1') {
    // First-party (shopify/klaviyo import) is treated as verified.
    identityPoints = 35;
    verificationStatus = 'verified';
    reasons.push('email_verified');
  } else if (!hasText(input.email)) {
    identityPoints = 0;
    verificationStatus = 'pending';
    reasons.push('email_missing');
  } else if (input.syntax_valid === false) {
    identityPoints = 0;
    verificationStatus = 'failed';
    reasons.push('email_syntax_invalid');
  } else if (input.is_disposable === true) {
    identityPoints = 0;
    verificationStatus = 'failed';
    reasons.push('email_disposable');
  } else if (input.mx_valid === false) {
    identityPoints = 5;
    verificationStatus = 'failed';
    reasons.push('email_no_mx');
  } else if (input.smtp_valid === true) {
    identityPoints = 35;
    verificationStatus = 'verified';
    reasons.push('email_verified');
  } else if (input.mx_valid === true && input.smtp_valid === false) {
    identityPoints = 15;
    verificationStatus = 'failed';
    reasons.push('email_smtp_failed');
  } else if (input.mx_valid === true) {
    // MX passed but no SMTP configured — treat as soft-verified.
    identityPoints = 25;
    verificationStatus = 'unverified';
    reasons.push('email_mx_only');
  } else {
    identityPoints = 0;
    verificationStatus = 'pending';
  }

  if (hasText(input.phone_e164)) {
    identityPoints += 5;
    reasons.push('phone_present');
  } else {
    reasons.push('phone_missing');
  }

  // --- Completeness ---
  let completenessPoints = 0;
  if (hasText(input.first_name) || hasText(input.last_name)) {
    completenessPoints += 6;
    reasons.push('name_present');
  }
  if (hasText(input.company)) {
    completenessPoints += 8;
    reasons.push('company_present');
  }
  if (hasText(input.city) || hasText(input.region)) {
    completenessPoints += 6;
    reasons.push('location_present');
  }
  if (completenessPoints < 8) reasons.push('completeness_low');

  // --- ICP fit ---
  let icpFitScore = 0;
  if (hasText(input.icp_segment) && KNOWN_ICP_SEGMENTS.has(input.icp_segment.toLowerCase())) {
    icpFitScore = 80;
    reasons.push('icp_match');
  } else if (hasText(input.icp_segment)) {
    icpFitScore = 40; // unknown segment — we keep it but it's weak.
  } else {
    icpFitScore = 0;
    reasons.push('icp_missing');
  }
  const icpPoints = Math.round((icpFitScore / 100) * 15); // up to 15

  // --- Source trust ---
  const sourcePoints =
    resolvedSourceTier === 'tier1' ? 20 :
    resolvedSourceTier === 'tier2' ? 10 : 0;

  // --- Freshness ---
  const age = daysSince(input.observed_at ?? null);
  const freshnessPoints =
    age === 0 ? 10 :
    age <= FRESH_WINDOW_DAYS ? 10 :
    age <= FRESH_WINDOW_DAYS * 3 ? 5 : 0;
  if (age > FRESH_WINDOW_DAYS * 3) reasons.push('stale');

  const rawScore = identityPoints + completenessPoints + icpPoints + sourcePoints + freshnessPoints;
  const qualityScore = clamp(rawScore);

  // --- Hard-reject gates (these override any positive score) ---
  if (input.is_suppressed) reasons.push('suppressed');
  if (input.is_duplicate) reasons.push('duplicate');

  // --- Export eligibility ---
  // Rules, per source tier:
  //   tier1: always eligible unless suppressed / duplicate
  //   tier2: eligible if verification_status in {verified, unverified} and score >= 70
  //   tier3: eligible only if verification_status == 'verified' and score >= 80
  let exportEligible = false;
  let blockedReason: string | null = null;

  if (input.is_suppressed) {
    blockedReason = 'suppressed';
  } else if (input.is_duplicate) {
    blockedReason = 'duplicate';
  } else if (verificationStatus === 'failed') {
    blockedReason = 'verification_failed';
  } else if (resolvedSourceTier === 'tier1') {
    // Already past the verification_status === 'failed' branch above, so
    // any first-party row that gets here is treated as eligible.
    exportEligible = true;
  } else if (resolvedSourceTier === 'tier2') {
    if (verificationStatus === 'verified' || verificationStatus === 'unverified') {
      if (qualityScore >= 70) {
        exportEligible = true;
      } else {
        blockedReason = 'below_export_threshold';
        reasons.push('below_export_threshold');
      }
    } else {
      blockedReason = 'verification_pending';
    }
  } else {
    // tier3 (scraped)
    if (verificationStatus === 'verified' && qualityScore >= 80) {
      exportEligible = true;
    } else if (verificationStatus !== 'verified') {
      blockedReason = 'scraped_without_verification';
      reasons.push('scraped_without_verification');
    } else {
      blockedReason = 'below_export_threshold';
      reasons.push('below_export_threshold');
    }
  }

  // --- Tier bucket (gold/silver/bronze/review/rejected) ---
  let tier: QualityTier;
  if (verificationStatus === 'failed' || input.is_suppressed) {
    tier = 'rejected';
  } else if (exportEligible && qualityScore >= 85) {
    tier = 'gold';
  } else if (exportEligible && qualityScore >= 70) {
    tier = 'silver';
  } else if (qualityScore >= 55) {
    tier = 'bronze';
  } else {
    tier = 'review';
  }

  // --- Review state ---
  // Ineligible-but-salvageable rows go to the review queue so an operator
  // (or a follow-up enrichment pass) can resolve them instead of being
  // silently dropped from the platform.
  let reviewState: ReviewState;
  if (exportEligible) {
    reviewState = 'none';
  } else if (tier === 'rejected') {
    // Rejected is a terminal state; keep it out of the queue unless duplicate/suppressed
    // (those stay 'none' too since nothing to review).
    reviewState = input.is_suppressed || input.is_duplicate ? 'none' : 'rejected';
  } else if (
    resolvedSourceTier === 'tier3' &&
    verificationStatus !== 'verified'
  ) {
    reviewState = 'quarantined';
  } else {
    reviewState = 'pending';
  }

  const nowIso = new Date().toISOString();

  return {
    quality_score: qualityScore,
    quality_tier: tier,
    verification_status: verificationStatus,
    verified_at: verificationStatus === 'verified' ? nowIso : null,
    source_tier: resolvedSourceTier,
    export_eligible: exportEligible,
    export_blocked_reason: exportEligible ? null : blockedReason,
    reason_codes: dedupe(reasons),
    icp_fit_score: icpFitScore,
    review_state: reviewState,
    quality_scored_at: nowIso,
  };
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

/**
 * Convenience: map a `QualityOutput` onto the column names used by the
 * `leads` table. Keeps insert payloads consistent across routes.
 */
export function toLeadColumns(q: QualityOutput) {
  return {
    quality_score: q.quality_score,
    quality_tier: q.quality_tier,
    verification_status: q.verification_status,
    verified_at: q.verified_at,
    source_tier: q.source_tier,
    export_eligible: q.export_eligible,
    export_blocked_reason: q.export_blocked_reason,
    reason_codes: q.reason_codes,
    icp_fit_score: q.icp_fit_score,
    review_state: q.review_state,
    quality_scored_at: q.quality_scored_at,
  };
}
