/**
 * Canonical lead quality scoring.
 *
 * Every ingestion path — /api/ingest, /api/places-salons, /api/scrape-osm,
 * /api/scrape-webscrapingai, /submit-lead — must run each row through
 * `scoreLead` before persisting. The result drives:
 *
 *   - `quality_score` (0–100)       — the single number shown in dashboards
 *   - `verification_status`         — what level of identity proof we have
 *   - `export_eligibility`          — gates the /api/export route
 *   - `reason_codes`                — explains the score to operators/UI
 *
 * Scoring is deterministic and input-only: same row → same score, no network.
 */
export type SourceTier = 'a' | 'b' | 'c' | 'd';

export type VerificationStatus =
  | 'unverified'
  | 'email_syntax'
  | 'email_mx'
  | 'email_smtp'
  | 'phone_only'
  | 'multi_channel'
  | 'failed';

export type ExportEligibility = 'eligible' | 'review' | 'quarantine';

export type ReasonCode =
  | 'EMAIL_SYNTAX_VALID'
  | 'EMAIL_SYNTAX_INVALID'
  | 'EMAIL_MX_VALID'
  | 'EMAIL_MX_MISSING'
  | 'EMAIL_SMTP_VALID'
  | 'EMAIL_SMTP_FAILED'
  | 'EMAIL_DISPOSABLE'
  | 'EMAIL_MISSING'
  | 'PHONE_PRESENT'
  | 'PHONE_MISSING'
  | 'NAME_PRESENT'
  | 'COMPANY_PRESENT'
  | 'COMPLETE_PROFILE'
  | 'SPARSE_PROFILE'
  | 'ICP_MATCH'
  | 'ICP_UNKNOWN'
  | 'DUPLICATE'
  | 'SUPPRESSED'
  | 'SOURCE_FIRST_PARTY'
  | 'SOURCE_VERIFIED_API'
  | 'SOURCE_DIRECTORY'
  | 'SOURCE_RAW_SCRAPE'
  | 'FRESH'
  | 'STALE';

export interface QualityInput {
  email?: string | null;
  phone_e164?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  icp_segment?: string | null;
  syntax_valid?: boolean;
  mx_valid?: boolean;
  smtp_valid?: boolean;
  is_disposable?: boolean;
  is_duplicate?: boolean;
  is_suppressed?: boolean;
  source_tier?: SourceTier;
  verified_at?: Date | string | null;
}

export interface QualityResult {
  quality_score: number;
  verification_status: VerificationStatus;
  export_eligibility: ExportEligibility;
  reason_codes: ReasonCode[];
}

const KNOWN_SEGMENTS = new Set([
  'b2c_beauty',
  'salon',
  'retailer',
  'influencer',
]);

export const KNOWN_ICP_SEGMENTS: readonly string[] = Array.from(KNOWN_SEGMENTS);

/**
 * Map a `sources.kind` string (or any upstream label) onto a tier.
 * Unknown kinds default to 'c' (directory/enrichment) — safe middle ground.
 */
export function sourceTierFromKind(
  kind: string | null | undefined,
): SourceTier {
  if (!kind) return 'c';
  const k = kind.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (k === 'firstparty' || k === 'first_party' || k === 'submit' || k === 'form') return 'a';
  if (k === 'apollo' || k === 'commonroom' || k === 'hunter' || k === 'snov' || k === 'purchased') return 'b';
  if (k === 'places' || k === 'google_places' || k === 'osm' || k === 'api' || k === 'import' || k === 'shopify' || k === 'klaviyo') return 'c';
  if (k === 'scraped' || k === 'webscraping' || k === 'webscrapingai' || k === 'scrape' || k === 'instagram') return 'd';
  return 'c';
}

/**
 * Score a single lead. Pure function — no DB, no network.
 *
 * Scoring bands (max 100):
 *   - verified identity  : 35  (email_smtp 20, mx 10, syntax 5; phone adds 10)
 *   - source confidence  : 25  (a=25, b=18, c=10, d=3)
 *   - ICP fit            : 10
 *   - completeness       : 15
 *   - freshness          : 15
 *
 * Disqualifiers clamp the score so DUPLICATE/SUPPRESSED/DISPOSABLE records
 * can never reach the export band regardless of other signal.
 */
export function scoreLead(input: QualityInput): QualityResult {
  const reasons: ReasonCode[] = [];
  let score = 0;

  // 1. Verified identity
  let verification: VerificationStatus = 'unverified';
  const email = input.email?.trim();
  if (!email) {
    reasons.push('EMAIL_MISSING');
  } else if (input.is_disposable) {
    reasons.push('EMAIL_DISPOSABLE');
    verification = 'failed';
  } else {
    if (input.syntax_valid) {
      reasons.push('EMAIL_SYNTAX_VALID');
      score += 5;
      verification = 'email_syntax';
    } else {
      reasons.push('EMAIL_SYNTAX_INVALID');
    }
    if (input.mx_valid) {
      reasons.push('EMAIL_MX_VALID');
      score += 10;
      verification = 'email_mx';
    } else if (input.syntax_valid) {
      reasons.push('EMAIL_MX_MISSING');
    }
    if (input.smtp_valid) {
      reasons.push('EMAIL_SMTP_VALID');
      score += 20;
      verification = 'email_smtp';
    } else if (input.mx_valid) {
      reasons.push('EMAIL_SMTP_FAILED');
    }
  }

  if (input.phone_e164) {
    reasons.push('PHONE_PRESENT');
    score += 10;
    if (verification === 'unverified' || verification === 'failed') {
      verification = 'phone_only';
    } else if (verification === 'email_smtp') {
      verification = 'multi_channel';
    }
  } else {
    reasons.push('PHONE_MISSING');
  }

  // 2. Source confidence
  const tier: SourceTier = input.source_tier ?? 'c';
  switch (tier) {
    case 'a':
      score += 25;
      reasons.push('SOURCE_FIRST_PARTY');
      break;
    case 'b':
      score += 18;
      reasons.push('SOURCE_VERIFIED_API');
      break;
    case 'c':
      score += 10;
      reasons.push('SOURCE_DIRECTORY');
      break;
    case 'd':
      score += 3;
      reasons.push('SOURCE_RAW_SCRAPE');
      break;
  }

  // 3. ICP fit
  if (input.icp_segment && KNOWN_SEGMENTS.has(input.icp_segment)) {
    reasons.push('ICP_MATCH');
    score += 10;
  } else {
    reasons.push('ICP_UNKNOWN');
  }

  // 4. Completeness
  const pieces =
    (input.first_name ? 1 : 0) +
    (input.last_name ? 1 : 0) +
    (input.company ? 1 : 0) +
    (input.title ? 1 : 0);
  if (pieces >= 3) {
    reasons.push('COMPLETE_PROFILE');
    score += 15;
  } else {
    score += pieces * 3;
    if (pieces === 0) reasons.push('SPARSE_PROFILE');
  }
  if (input.first_name) reasons.push('NAME_PRESENT');
  if (input.company) reasons.push('COMPANY_PRESENT');

  // 5. Freshness
  const verifiedAt = input.verified_at ? new Date(input.verified_at) : null;
  if (verifiedAt && !Number.isNaN(verifiedAt.getTime())) {
    const ageDays =
      (Date.now() - verifiedAt.getTime()) / 86_400_000;
    if (ageDays < 30) {
      score += 15;
      reasons.push('FRESH');
    } else if (ageDays < 90) {
      score += 8;
    } else {
      reasons.push('STALE');
    }
  }

  // Disqualifier clamps. Order matters: suppression is the hardest stop.
  if (input.is_suppressed) {
    reasons.push('SUPPRESSED');
    score = Math.min(score, 10);
  }
  if (input.is_duplicate) {
    reasons.push('DUPLICATE');
    score = Math.min(score, 20);
  }
  if (input.is_disposable) {
    score = Math.min(score, 5);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Export eligibility — explicit ladder, not a threshold formula, so the
  // rules are auditable line-by-line.
  let eligibility: ExportEligibility;
  if (input.is_suppressed || input.is_duplicate || input.is_disposable) {
    eligibility = 'quarantine';
  } else if (verification === 'failed') {
    eligibility = 'quarantine';
  } else if (
    score >= 70 &&
    (input.smtp_valid || (input.mx_valid && tier === 'a'))
  ) {
    eligibility = 'eligible';
  } else if (score < 30) {
    eligibility = 'quarantine';
  } else {
    eligibility = 'review';
  }

  return {
    quality_score: score,
    verification_status: verification,
    export_eligibility: eligibility,
    reason_codes: reasons,
  };
}
