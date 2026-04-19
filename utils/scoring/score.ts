/**
 * Deterministic quality scoring for OneClickitLeads.
 *
 * Called from every ingestion path (api ingest, places-salons, osm,
 * webscraping.ai, shopify seed) so there is exactly one rubric. The scoring
 * decisions are explainable via `reason_codes`, which the dashboard renders
 * back as chips next to each lead.
 *
 * The function is pure and has no IO — scrub the lead first (email/phone/
 * dedupe/suppression) and feed the result in alongside the source kind.
 */

export type QualityTier = 'A' | 'B' | 'C' | 'D' | 'F';
export type VerificationStatus = 'verified' | 'probable' | 'unverified' | 'failed';
export type ReviewState = 'approved' | 'pending' | 'quarantined' | 'rejected';

export interface ScoringInput {
  // scrub outputs
  syntax_valid?: boolean | null;
  mx_valid?: boolean | null;
  smtp_valid?: boolean | null;
  is_disposable?: boolean | null;
  is_duplicate?: boolean | null;
  is_suppressed?: boolean | null;
  reject_reason?: string | null;

  // identity
  email?: string | null;
  phone_e164?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;

  // ICP
  icp_segment?: string | null;
  tags?: string[] | null;

  // signals (Google Places, first-party orders, etc.)
  rating?: number | null;
  rating_count?: number | null;

  // provenance
  source_kind?: string | null;      // 'firstparty'|'apollo'|'commonroom'|'api'|'places'|'osm'|'scraped'|'purchased'|'hunter'
}

export interface ScoringResult {
  quality_score: number;            // 0-100
  quality_tier: QualityTier;
  verification_status: VerificationStatus;
  source_tier: 1 | 2 | 3 | 4;
  reason_codes: string[];
  export_eligible: boolean;
  review_state: ReviewState;
}

/**
 * Reason code vocabulary. Keep stable: dashboard UI and audit logs depend
 * on these exact strings.
 */
export const REASON = {
  VERIFIED_SMTP: 'verified_smtp',
  MX_ONLY: 'mx_only',
  SYNTAX_ONLY: 'syntax_only',
  NO_EMAIL: 'no_email',
  BAD_SYNTAX: 'bad_syntax',
  DISPOSABLE: 'disposable_domain',
  SUPPRESSED: 'on_suppression_list',
  DUPLICATE: 'duplicate_of_existing',
  FIRST_PARTY: 'first_party_source',
  VERIFIED_API: 'verified_api_source',
  DIRECTORY_SOURCE: 'directory_source',
  OPEN_SCRAPE: 'open_scrape_source',
  HIGH_COMPLETENESS: 'high_completeness',
  LOW_COMPLETENESS: 'low_completeness',
  ICP_MATCH: 'icp_match',
  ICP_UNKNOWN: 'icp_unknown',
  HIGH_RATING: 'high_rating_signal',
  BUSY_BUSINESS: 'busy_business_signal',
  REPEAT_BUYER: 'repeat_buyer_signal',
  OPTED_IN: 'opt_in_signal',
  HAS_PHONE: 'has_phone',
} as const;

/** Map the loose `sources.kind` string into a 1-4 tier label. */
export function sourceTierFor(kind: string | null | undefined): 1 | 2 | 3 | 4 {
  switch ((kind ?? '').toLowerCase()) {
    case 'firstparty':
      return 1;
    case 'apollo':
    case 'commonroom':
    case 'api':
      return 2;
    case 'hunter':
    case 'places':
    case 'google_places':
    case 'osm':
    case 'purchased':
      return 3;
    case 'scraped':
    case 'webscraping.ai':
      return 4;
    default:
      return 3;
  }
}

/**
 * Convert a numeric score to a letter tier using fixed thresholds.
 * Export gate lives at 70 (B tier and above).
 */
export function tierFor(score: number): QualityTier {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 30) return 'D';
  return 'F';
}

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function hasText(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Core scoring function. Pure, deterministic, single rubric.
 *
 * Weights (sum = 100):
 *   Verification  40
 *   Completeness  20
 *   Source        15
 *   ICP fit       10
 *   Freshness     10  (always 10 on ingest; nightly job decays this later)
 *   Signals        5
 */
export function scoreLead(input: ScoringInput): ScoringResult {
  const codes: string[] = [];

  // Hard rejects first — nothing else matters.
  if (input.is_disposable) codes.push(REASON.DISPOSABLE);
  if (input.is_suppressed) codes.push(REASON.SUPPRESSED);
  if (input.is_duplicate)  codes.push(REASON.DUPLICATE);
  if (input.reject_reason === 'bad_syntax') codes.push(REASON.BAD_SYNTAX);

  const hardReject =
    !!input.is_disposable ||
    !!input.is_suppressed ||
    input.reject_reason === 'bad_syntax';

  // Verification block (0-40)
  let verificationPts = 0;
  let verification: VerificationStatus = 'failed';
  if (hasText(input.email)) {
    if (input.smtp_valid) {
      verificationPts = 40;
      verification = 'verified';
      codes.push(REASON.VERIFIED_SMTP);
    } else if (input.mx_valid) {
      verificationPts = 25;
      verification = 'probable';
      codes.push(REASON.MX_ONLY);
    } else if (input.syntax_valid) {
      verificationPts = 10;
      verification = 'unverified';
      codes.push(REASON.SYNTAX_ONLY);
    } else {
      verificationPts = 0;
      verification = 'failed';
    }
  } else if (hasText(input.phone_e164)) {
    // Phone-only (Google Places / OSM salons with no email on file). Treat
    // as "probable" so a high-signal salon isn't auto-quarantined for
    // lacking email — enrichment will backfill it.
    verificationPts = 15;
    verification = 'probable';
    codes.push(REASON.NO_EMAIL);
    codes.push(REASON.HAS_PHONE);
  } else {
    verification = 'failed';
    codes.push(REASON.NO_EMAIL);
  }

  // Completeness (0-20). 4 points per present field, up to 5 fields.
  const completenessFields: Array<string | null | undefined> = [
    input.first_name,
    input.company,
    input.phone_e164 ?? input.email,
    input.city,
    input.title,
  ];
  const filled = completenessFields.filter(hasText).length;
  const completenessPts = Math.min(20, filled * 4);
  codes.push(filled >= 4 ? REASON.HIGH_COMPLETENESS : REASON.LOW_COMPLETENESS);

  // Source confidence (0-15)
  const tier = sourceTierFor(input.source_kind);
  const sourcePts = tier === 1 ? 15 : tier === 2 ? 12 : tier === 3 ? 8 : 4;
  codes.push(
    tier === 1 ? REASON.FIRST_PARTY :
    tier === 2 ? REASON.VERIFIED_API :
    tier === 3 ? REASON.DIRECTORY_SOURCE :
    REASON.OPEN_SCRAPE
  );

  // ICP fit (0-10)
  let icpPts = 0;
  if (hasText(input.icp_segment)) {
    icpPts += 5;
    codes.push(REASON.ICP_MATCH);
  } else {
    codes.push(REASON.ICP_UNKNOWN);
  }
  const tags = input.tags ?? [];
  if (tags.some((t) => /beauty|salon|influencer|retailer|clean|vegan|brow|lash|mua/i.test(t))) {
    icpPts += 5;
  }

  // Freshness (0-10). On ingest we're fresh; a nightly job can decay this.
  const freshnessPts = 10;

  // Signals (0-5). Rating, review volume, opt-in, repeat buyer.
  let signalPts = 0;
  const rating = Number(input.rating ?? 0);
  const ratingCount = Number(input.rating_count ?? 0);
  if (rating >= 4.5 && ratingCount >= 50) {
    signalPts += 3;
    codes.push(REASON.HIGH_RATING);
  } else if (ratingCount >= 100) {
    signalPts += 1;
    codes.push(REASON.BUSY_BUSINESS);
  }
  if (tags.some((t) => /opted_in/i.test(t))) {
    signalPts += 1;
    codes.push(REASON.OPTED_IN);
  }
  if (tags.some((t) => /repeat_buyer/i.test(t))) {
    signalPts += 1;
    codes.push(REASON.REPEAT_BUYER);
  }
  signalPts = Math.min(5, signalPts);

  let score = verificationPts + completenessPts + sourcePts + icpPts + freshnessPts + signalPts;
  if (hardReject) score = Math.min(score, 20);
  if (input.is_duplicate) score = Math.min(score, 40); // salvageable if operator force-approves

  score = clamp(score);
  const quality_tier = tierFor(score);

  // Review state + export gate.
  //   rejected    → never re-enters funnel (disposable, bad syntax, suppressed)
  //   quarantined → weak verification or weak score, needs operator or re-verify
  //   pending     → default; waiting on the scoring engine / ops decision
  //   approved    → export_eligible = true
  let review_state: ReviewState;
  let export_eligible = false;

  if (hardReject) {
    review_state = 'rejected';
  } else if (input.is_duplicate) {
    review_state = 'quarantined';
  } else if (score >= 70 && verification !== 'failed' && tier <= 3) {
    review_state = 'approved';
    export_eligible = true;
  } else if (score >= 55) {
    review_state = 'pending';
  } else {
    review_state = 'quarantined';
  }

  // Tier-4 (open scrape) never auto-exports, even if score is high — the
  // operator must approve, or an enrichment run must upgrade its source.
  if (tier === 4 && review_state === 'approved') {
    review_state = 'pending';
    export_eligible = false;
  }

  return {
    quality_score: score,
    quality_tier,
    verification_status: verification,
    source_tier: tier,
    reason_codes: Array.from(new Set(codes)),
    export_eligible,
    review_state,
  };
}

/**
 * Convenience: apply `scoreLead` to every row in an array and return the
 * rows merged with the scoring result. Used by scrubBatch.
 */
export function scoreMany<T extends ScoringInput>(
  rows: T[],
  source_kind: string | null | undefined
): Array<T & ScoringResult> {
  return rows.map((row) => {
    const result = scoreLead({ ...row, source_kind: row.source_kind ?? source_kind });
    return { ...row, ...result };
  });
}
