/**
 * Canonical lead scoring engine.
 *
 * Deterministic, pure function. Given what we know about a lead, returns:
 *   - quality_score       0–100 (clamped, integer)
 *   - quality_reasons     reason codes the UI can show ("why is this a 72?")
 *   - verification_status identity confidence bucket
 *   - source_tier         trust tier derived from the ingestion source
 *   - review_state        whether the lead is ready, needs review, or is quarantined
 *   - export_eligible     final go/no-go the export routes filter on
 *
 * Keep the vocabulary in sync with migration 0005 (check constraints encode
 * the same enums; drifting means RLS-safe inserts start failing).
 *
 * Scoring is intentionally explicit: each bump carries a reason code so the
 * dashboard can explain the number instead of showing an opaque score.
 */
import type { SourceKind, SourceTier, VerificationStatus, ReviewState } from './types';

export const QUALITY_MIN_FOR_EXPORT = 60;

export interface ScoringInput {
  // identity
  email?: string | null;
  phone_e164?: string | null;
  first_name?: string | null;
  last_name?: string | null;

  // firmographics / enrichment
  company?: string | null;
  title?: string | null;
  linkedin_url?: string | null;
  instagram_handle?: string | null;
  website?: string | null;

  // geo
  city?: string | null;
  region?: string | null;
  country?: string | null;

  // ICP
  icp_segment?: string | null;
  tags?: string[] | null;

  // google places signal
  rating?: number | null;
  rating_count?: number | null;

  // scrub outcome
  is_scrubbed?: boolean;
  is_duplicate?: boolean;
  is_suppressed?: boolean;
  is_disposable?: boolean;
  syntax_valid?: boolean;
  mx_valid?: boolean;
  smtp_valid?: boolean;
  reject_reason?: string | null;

  // provenance
  source_kind?: SourceKind | string | null;
  source_url?: string | null;
  ingested_at?: string | Date | null;
  verified_at?: string | Date | null;

  // optional pre-set override (e.g. first-party opt-in)
  manual_verified?: boolean;
}

export interface ScoringResult {
  quality_score: number;
  quality_reasons: string[];
  verification_status: VerificationStatus;
  source_tier: SourceTier;
  review_state: ReviewState;
  export_eligible: boolean;
}

const ALLOWED_ICPS = new Set(['b2c_beauty', 'salon', 'retailer', 'influencer']);

export function sourceTierFor(kind: SourceKind | string | null | undefined): SourceTier {
  switch ((kind ?? '').toLowerCase()) {
    case 'firstparty':
    case 'shopify':
    case 'klaviyo':
    case 'opt_in':
      return 'firstparty';
    case 'apollo':
    case 'commonroom':
    case 'hunter':
    case 'snov':
    case 'zoominfo':
    case 'api':
      return 'verified_api';
    case 'google_places':
    case 'osm':
    case 'places':
      return 'public_directory';
    case 'scrapingbee':
    case 'brightdata':
    case 'webscraping.ai':
    case 'webscraping_ai':
    case 'scraped':
      return 'scraped';
    case 'purchased':
      return 'purchased';
    default:
      return 'unknown';
  }
}

function verificationFor(input: ScoringInput): VerificationStatus {
  if (input.manual_verified) return 'manual_verified';
  if (input.reject_reason === 'smtp_failed' || input.reject_reason === 'no_mx') return 'bounced';
  if (input.reject_reason === 'bad_syntax' || input.reject_reason === 'disposable_domain') return 'bounced';
  if (input.smtp_valid) return 'smtp_verified';
  if (input.mx_valid) return 'mx_only';
  return 'unverified';
}

function daysSince(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 86_400_000;
}

function clamp(n: number, min = 0, max = 100): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function scoreLead(input: ScoringInput): ScoringResult {
  const reasons: string[] = [];
  const tier = sourceTierFor(input.source_kind);
  const verification = verificationFor(input);

  // Hard-fail gates: the lead never reaches export, no matter what else we know.
  const hardFail =
    input.is_duplicate === true ||
    input.is_suppressed === true ||
    input.is_disposable === true ||
    input.syntax_valid === false ||
    verification === 'bounced';

  let score = 0;

  // ── identity / verification (max ~40) ────────────────────────────────
  if (verification === 'manual_verified') {
    score += 35;
    reasons.push('identity.manual_verified');
  } else if (verification === 'smtp_verified') {
    score += 30;
    reasons.push('identity.smtp_verified');
  } else if (verification === 'mx_only') {
    score += 18;
    reasons.push('identity.mx_only');
  } else if (verification === 'bounced') {
    reasons.push('identity.bounced');
  } else {
    reasons.push('identity.unverified');
  }

  if (input.phone_e164) {
    score += 10;
    reasons.push('identity.phone_present');
  }

  // ── ICP fit (max ~10) ────────────────────────────────────────────────
  if (input.icp_segment && ALLOWED_ICPS.has(input.icp_segment)) {
    score += 10;
    reasons.push(`icp.match.${input.icp_segment}`);
  } else if (input.icp_segment) {
    score += 3;
    reasons.push('icp.unmapped');
  } else {
    reasons.push('icp.missing');
  }

  // ── completeness (max ~15) ────────────────────────────────────────────
  if (input.first_name && input.last_name) {
    score += 5;
    reasons.push('completeness.name');
  }
  if (input.company) {
    score += 3;
    reasons.push('completeness.company');
  }
  if (input.title) {
    score += 2;
    reasons.push('completeness.title');
  }
  if (input.city && input.region) {
    score += 3;
    reasons.push('completeness.geo');
  }
  if (input.website || input.linkedin_url || input.instagram_handle) {
    score += 2;
    reasons.push('completeness.web_presence');
  }

  // ── intent / authority signals (max ~10) ─────────────────────────────
  if (typeof input.rating === 'number' && typeof input.rating_count === 'number') {
    const authority = input.rating * Math.log10(Math.max(input.rating_count, 1));
    // 4.5★ × log10(250) ≈ 10.8 → caps at +8.
    const bump = Math.min(8, Math.round(authority));
    if (bump > 0) {
      score += bump;
      reasons.push(`intent.google_authority+${bump}`);
    }
  }
  if (input.tags?.includes('opted_in')) {
    score += 5;
    reasons.push('intent.opted_in');
  }
  if (input.tags?.includes('repeat_buyer')) {
    score += 3;
    reasons.push('intent.repeat_buyer');
  }

  // ── source confidence (max ~15, min −5) ───────────────────────────────
  if (tier === 'firstparty') {
    score += 15;
    reasons.push('source.firstparty');
  } else if (tier === 'verified_api') {
    score += 10;
    reasons.push('source.verified_api');
  } else if (tier === 'public_directory') {
    score += 5;
    reasons.push('source.public_directory');
  } else if (tier === 'scraped') {
    reasons.push('source.scraped');
  } else if (tier === 'purchased') {
    score -= 5;
    reasons.push('source.purchased_penalty');
  } else {
    reasons.push('source.unknown');
  }

  // ── freshness (±5) ────────────────────────────────────────────────────
  const verifiedAge = daysSince(input.verified_at);
  const ingestAge = daysSince(input.ingested_at);
  const age = verifiedAge ?? ingestAge;
  if (age !== null) {
    if (age <= 30) {
      score += 5;
      reasons.push('freshness.fresh');
    } else if (age <= 180) {
      reasons.push('freshness.recent');
    } else if (age <= 365) {
      score -= 5;
      reasons.push('freshness.stale');
    } else {
      score -= 10;
      reasons.push('freshness.expired');
    }
  } else {
    reasons.push('freshness.unknown');
  }

  // ── hard-fail collapse ───────────────────────────────────────────────
  if (hardFail) {
    if (input.is_duplicate) reasons.push('gate.duplicate');
    if (input.is_suppressed) reasons.push('gate.suppressed');
    if (input.is_disposable) reasons.push('gate.disposable');
    if (input.syntax_valid === false) reasons.push('gate.bad_syntax');
    score = Math.min(score, 25);
  }

  const quality_score = Math.round(clamp(score, 0, 100));

  // Review state is deliberately conservative: public scraping + mid scores
  // go to review, not straight to export. First-party can fast-track.
  let review_state: ReviewState;
  if (hardFail) {
    review_state = 'quarantined';
  } else if (
    quality_score >= QUALITY_MIN_FOR_EXPORT &&
    (verification === 'smtp_verified' ||
      verification === 'manual_verified' ||
      (tier === 'firstparty' && verification !== 'unverified'))
  ) {
    review_state = 'ready';
  } else if (quality_score >= QUALITY_MIN_FOR_EXPORT && verification === 'mx_only' && tier !== 'scraped' && tier !== 'purchased') {
    review_state = 'ready';
  } else {
    review_state = 'review';
  }

  const eligibleStates: ReviewState[] = ['ready', 'approved'];
  const export_eligible =
    !hardFail &&
    eligibleStates.includes(review_state) &&
    quality_score >= QUALITY_MIN_FOR_EXPORT &&
    (input.is_scrubbed ?? false);

  return {
    quality_score,
    quality_reasons: reasons,
    verification_status: verification,
    source_tier: tier,
    review_state,
    export_eligible,
  };
}
