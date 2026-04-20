// Canonical quality-first scoring engine.
//
// One deterministic function decides every lead's quality_score,
// verification_status, source_tier, export_eligibility, and reason_codes.
// All ingestion paths (ingest, import, enrich, scrape-osm, webscraping.ai,
// places-salons, submit-lead) pipe their rows through this — route handlers
// MUST NOT invent their own scoring logic.
//
// Scores clamp to [0, 100]. Reason codes are stable machine-readable
// strings the dashboard can surface verbatim ("why is this lead in review?").

export type SourceTier =
  | 'firstparty'      // Shopify / Klaviyo / client CRM export
  | 'verified_api'    // Apollo, Common Room, Hunter, Snov, ZoomInfo
  | 'directory'       // Google Places, OSM — business listings
  | 'scraped'         // webscraping.ai, ScrapingBee, BrightData, harvested HTML
  | 'purchased'       // external list buy
  | 'unknown';

export type VerificationStatus =
  | 'unverified'
  | 'syntax_only'
  | 'mx_verified'
  | 'smtp_verified'
  | 'failed';

export type ExportEligibility =
  | 'eligible'
  | 'review'
  | 'quarantined'
  | 'suppressed'
  | 'exported';

/** Inputs accepted by the scorer. Every field is optional — a partial row is a
 *  valid input and will score low with explicit reason codes. */
export interface ScoreInput {
  email?: string | null;
  phone_e164?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  icp_segment?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  tags?: string[] | null;

  // From the scrub pipeline
  syntax_valid?: boolean | null;
  mx_valid?: boolean | null;
  smtp_valid?: boolean | null;
  is_disposable?: boolean | null;
  is_duplicate?: boolean | null;
  is_suppressed?: boolean | null;

  // Source info
  source_kind?: string | null;          // sources.kind (raw)
  source_tier?: SourceTier | null;      // override; otherwise derived from source_kind

  // Signal heuristics
  rating?: number | null;               // Google rating 0–5
  rating_count?: number | null;         // # of reviews

  // Freshness — when the row was last verified against provider or source
  verified_at?: Date | string | null;
}

export interface ScoreResult {
  quality_score: number;
  verification_status: VerificationStatus;
  source_tier: SourceTier;
  export_eligibility: ExportEligibility;
  reason_codes: string[];
}

const MAX_FRESHNESS_DAYS = 90;

/** Map a raw source kind (table column `sources.kind`) to a tier. */
export function sourceTierFromKind(kind: string | null | undefined): SourceTier {
  const k = (kind ?? '').toLowerCase();
  if (['firstparty', 'shopify', 'klaviyo'].includes(k)) return 'firstparty';
  if (['apollo', 'commonroom', 'hunter', 'snov', 'zoominfo'].includes(k)) return 'verified_api';
  if (['places', 'google_places', 'osm', 'directory', 'api'].includes(k)) return 'directory';
  if (['scraped', 'webscraping', 'scrapingbee', 'brightdata'].includes(k)) return 'scraped';
  if (['purchased', 'list'].includes(k)) return 'purchased';
  return 'unknown';
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function verificationStatusOf(input: ScoreInput): VerificationStatus {
  if (input.smtp_valid === true) return 'smtp_verified';
  if (input.mx_valid === true) return 'mx_verified';
  if (input.syntax_valid === false) return 'failed';
  if (input.syntax_valid === true) return 'syntax_only';
  return 'unverified';
}

function freshnessDays(verifiedAt: Date | string | null | undefined): number | null {
  if (!verifiedAt) return null;
  const d = verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

/** Deterministic scoring. Given identical inputs it returns identical outputs. */
export function scoreLead(input: ScoreInput): ScoreResult {
  const reasons: string[] = [];
  const tier: SourceTier =
    input.source_tier ?? sourceTierFromKind(input.source_kind ?? null);
  const verification = verificationStatusOf(input);
  const hasEmail = !!(input.email && input.email.trim());
  const hasPhone = !!(input.phone_e164 && input.phone_e164.trim());

  // ---- Hard gates (run first, short-circuit) -----------------------------
  if (input.is_suppressed) {
    reasons.push('suppressed');
    return {
      quality_score: 0,
      verification_status: verification,
      source_tier: tier,
      export_eligibility: 'suppressed',
      reason_codes: reasons,
    };
  }

  if (!hasEmail && !hasPhone) {
    reasons.push('no_contact_method');
    return {
      quality_score: 0,
      verification_status: verification,
      source_tier: tier,
      export_eligibility: 'quarantined',
      reason_codes: reasons,
    };
  }

  if (input.is_disposable) reasons.push('disposable_domain');
  if (input.is_duplicate) reasons.push('duplicate');
  if (verification === 'failed') reasons.push('invalid_syntax');
  if (hasEmail && input.mx_valid === false) reasons.push('no_mx');

  // Hard-fail if we have nothing usable to reach them by
  if (input.is_disposable || input.is_duplicate) {
    return {
      quality_score: 0,
      verification_status: verification,
      source_tier: tier,
      export_eligibility: 'quarantined',
      reason_codes: reasons,
    };
  }

  // ---- Positive signals --------------------------------------------------
  let score = 0;

  // (A) Verification — up to 40 pts. Biggest lever because it directly
  // predicts deliverability, which is what Chella is paying for.
  if (verification === 'smtp_verified') {
    score += 40;
    reasons.push('smtp_verified');
  } else if (verification === 'mx_verified') {
    score += 25;
    reasons.push('mx_verified');
  } else if (verification === 'syntax_only') {
    score += 10;
    reasons.push('syntax_only');
  } else if (verification === 'failed') {
    // already pushed 'invalid_syntax'
  } else if (hasPhone && !hasEmail) {
    // phone-only B2B record (salon from Google Places) — give partial credit
    score += 15;
    reasons.push('phone_only_contact');
  } else {
    reasons.push('unverified_email');
  }

  // (B) Completeness — up to 20 pts
  let completeness = 0;
  if (hasEmail) completeness += 5;
  if (hasPhone) completeness += 5;
  if (input.first_name) completeness += 3;
  if (input.last_name) completeness += 2;
  if (input.company) completeness += 3;
  if (input.title) completeness += 2;
  score += completeness;
  if (completeness < 8) reasons.push('incomplete_profile');

  // (C) Source confidence — up to 20 pts
  switch (tier) {
    case 'firstparty':
      score += 20;
      reasons.push('firstparty_source');
      break;
    case 'verified_api':
      score += 14;
      reasons.push('verified_api_source');
      break;
    case 'directory':
      score += 8;
      reasons.push('directory_source');
      break;
    case 'scraped':
      score += 4;
      reasons.push('scraped_source');
      break;
    case 'purchased':
      score += 2;
      reasons.push('purchased_source');
      break;
    case 'unknown':
      reasons.push('unknown_source');
      break;
  }

  // (D) ICP fit — up to 10 pts
  if (input.icp_segment) {
    score += 5;
    reasons.push(`icp:${input.icp_segment}`);
  } else {
    reasons.push('missing_icp_segment');
  }
  const tagSet = new Set((input.tags ?? []).map((t) => t.toLowerCase()));
  if (['opted_in', 'repeat_buyer', 'verified_buyer'].some((t) => tagSet.has(t))) {
    score += 5;
    reasons.push('positive_intent_tag');
  }

  // (E) Intent / rating signals — up to 10 pts
  const rating = input.rating ?? 0;
  const ratingCount = input.rating_count ?? 0;
  const ratingSignal = rating * ratingCount;
  if (ratingSignal >= 500) {
    score += 10;
    reasons.push('strong_public_signal');
  } else if (ratingSignal >= 100) {
    score += 5;
    reasons.push('moderate_public_signal');
  } else if (ratingSignal > 0) {
    score += 2;
  }

  // (F) Freshness penalty — we can't let stale verifications
  // silently count as deliverable forever.
  const days = freshnessDays(input.verified_at);
  if (days !== null) {
    if (days > MAX_FRESHNESS_DAYS * 2) {
      score -= 15;
      reasons.push('stale_verification');
    } else if (days > MAX_FRESHNESS_DAYS) {
      score -= 7;
      reasons.push('aging_verification');
    } else {
      reasons.push('fresh_verification');
    }
  }

  const finalScore = clamp(score);

  // ---- Export eligibility -----------------------------------------------
  // eligible: high-trust + deliverable OR trusted first-party
  // review:   mid-trust — operator should approve before export
  // quarantined: low-trust, scraped-only, or unverifiable
  let eligibility: ExportEligibility;
  const deliverable = verification === 'smtp_verified' || verification === 'mx_verified';
  const firstpartyTrust = tier === 'firstparty';

  if (firstpartyTrust && finalScore >= 60) {
    eligibility = 'eligible';
  } else if (finalScore >= 70 && deliverable && tier !== 'scraped') {
    eligibility = 'eligible';
  } else if (finalScore >= 55 && deliverable) {
    // scraped but MX-verified — still needs human eyes before export
    eligibility = 'review';
    if (tier === 'scraped') reasons.push('scraped_needs_review');
  } else if (finalScore >= 40) {
    eligibility = 'review';
  } else {
    eligibility = 'quarantined';
    reasons.push('score_below_threshold');
  }

  return {
    quality_score: finalScore,
    verification_status: verification,
    source_tier: tier,
    export_eligibility: eligibility,
    reason_codes: dedupe(reasons),
  };
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/** Tiny utility for ingestion routes: build the DB insert payload fragment
 *  that corresponds to a ScoreResult. Keeps ingestion routes declarative. */
export function scoreToDbFields(r: ScoreResult) {
  return {
    quality_score: r.quality_score,
    verification_status: r.verification_status,
    source_tier: r.source_tier,
    export_eligibility: r.export_eligibility,
    reason_codes: r.reason_codes,
    review_state: r.export_eligibility === 'review' ? 'pending' : 'none',
  };
}
