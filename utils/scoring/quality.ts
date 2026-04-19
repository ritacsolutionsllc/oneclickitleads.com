/**
 * Canonical lead-quality scoring engine.
 *
 * Every ingest path (/api/ingest, /api/places-salons, /api/scrape-osm,
 * /api/scrape-webscrapingai, /api/import/shopify, /api/harvest-emails, ...)
 * routes its rows through this one function. The output decides whether a
 * lead lands in `export_eligibility = 'eligible' | 'review' | 'quarantine'
 * | 'rejected'`, and the `reason_codes` it emits power the dashboard
 * "why this score" surface.
 *
 * Dimensions (clamped to 0-100):
 *   - Identity (0-35) — syntax, MX, SMTP, first-party
 *   - Completeness (0-15) — name/company/title/phone/location/url
 *   - Source tier (0-20) — A first-party > B paid API > C directory > D scraped
 *   - ICP fit (0-15) — segment set + recognised ICP tags
 *   - Freshness (0-10) — age of last_verified_at
 *   - Intent (0-5) — Places rating × count, repeat_buyer, opted_in
 *
 * Intentionally deterministic: same input -> same score, no LLM, no
 * randomness. Easy to test, easy to explain to a customer.
 */
import type { ScrubbedLead } from '@/utils/scrub/pipeline';

export type VerificationStatus =
  | 'unverified'
  | 'syntax_valid'
  | 'mx_valid'
  | 'smtp_verified'
  | 'first_party';

export type SourceTier = 'A' | 'B' | 'C' | 'D';

export type ExportEligibility =
  | 'eligible'
  | 'review'
  | 'quarantine'
  | 'rejected';

export type SourceKind =
  | 'firstparty'
  | 'apollo'
  | 'commonroom'
  | 'purchased'
  | 'hunter'
  | 'api'
  | 'scraped'
  | 'osm'
  | string;

export interface QualityInput {
  /** Minimum fields the scrub pipeline already fills in. */
  syntax_valid?: boolean | null;
  mx_valid?: boolean | null;
  smtp_valid?: boolean | null;
  is_disposable?: boolean | null;
  is_duplicate?: boolean | null;
  is_suppressed?: boolean | null;
  reject_reason?: string | null;

  /** Identity + completeness signals. */
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
  website?: string | null;
  source_url?: string | null;

  icp_segment?: string | null;
  tags?: string[] | null;

  /** Source lineage. */
  source_kind?: SourceKind | null;
  /** True when the row came from a first-party CRM/ESP (Shopify, Klaviyo). */
  first_party?: boolean;

  /** Intent signals. */
  rating?: number | null;
  rating_count?: number | null;

  /** ISO timestamp of last verification. Defaults to "now" when omitted. */
  last_verified_at?: string | Date | null;
}

export interface QualityResult {
  quality_score: number;
  verification_status: VerificationStatus;
  source_tier: SourceTier;
  export_eligibility: ExportEligibility;
  reason_codes: string[];
}

/** Known ICP segments that count toward ICP fit. Keep in sync with Plan docs. */
const KNOWN_ICP_SEGMENTS = new Set([
  'b2c_beauty',
  'salon',
  'retailer',
  'influencer',
]);

/** Tag substrings that hint at a positive ICP fit for Chella + similar DTC beauty. */
const ICP_TAG_SIGNALS = [
  'clean_beauty',
  'vegan',
  'cruelty_free',
  'brow',
  'lash',
  'beauty',
  'cosmetics',
  'opted_in',
  'repeat_buyer',
  'influencer',
  'salon',
];

const TIER_POINTS: Record<SourceTier, number> = { A: 20, B: 15, C: 10, D: 5 };

/** Hard reject reasons that short-circuit to export_eligibility='rejected'. */
const HARD_REJECT_REASONS = new Set([
  'bad_syntax',
  'disposable_domain',
  'suppressed',
  'duplicate',
]);

export function classifySourceTier(kind: SourceKind | null | undefined, firstParty?: boolean): SourceTier {
  if (firstParty) return 'A';
  switch (kind) {
    case 'firstparty':
      return 'A';
    case 'apollo':
    case 'commonroom':
    case 'purchased':
    case 'hunter':
    case 'api':
      return 'B';
    case 'scraped':
      // /api/places-salons and /api/scrape-osm write kind='scraped' but the
      // data is operator-grade business-directory data, not open-web scrape.
      // Callers pass first_party=false, so we default to tier C; pure web
      // scrapers pass source_kind='webscraping' to drop to D.
      return 'C';
    case 'osm':
      return 'C';
    case 'webscraping':
    case 'harvest':
      return 'D';
    default:
      return 'D';
  }
}

function classifyVerification(input: QualityInput): VerificationStatus {
  if (input.first_party) return 'first_party';
  if (input.smtp_valid) return 'smtp_verified';
  if (input.mx_valid) return 'mx_valid';
  if (input.syntax_valid) return 'syntax_valid';
  return 'unverified';
}

function freshnessPoints(at: string | Date | null | undefined): { pts: number; code: string } {
  if (!at) return { pts: 10, code: 'FRESH_NEW' };
  const ts = typeof at === 'string' ? new Date(at).getTime() : at.getTime();
  if (Number.isNaN(ts)) return { pts: 10, code: 'FRESH_NEW' };
  const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (days <= 7) return { pts: 10, code: 'FRESH_7D' };
  if (days <= 30) return { pts: 8, code: 'FRESH_30D' };
  if (days <= 90) return { pts: 5, code: 'FRESH_90D' };
  if (days <= 180) return { pts: 2, code: 'FRESH_180D' };
  return { pts: 0, code: 'STALE' };
}

function nonEmpty(v: string | null | undefined): boolean {
  return !!(v && v.trim());
}

/** Compute the canonical quality verdict for a single lead. */
export function scoreLead(input: QualityInput): QualityResult {
  const reasons: string[] = [];

  // ---- Identity (0-35) ----
  const verification = classifyVerification(input);
  let identity = 0;
  switch (verification) {
    case 'first_party':
      identity = 35;
      reasons.push('ID_FIRST_PARTY');
      break;
    case 'smtp_verified':
      identity = 30;
      reasons.push('ID_SMTP_VERIFIED');
      break;
    case 'mx_valid':
      identity = 20;
      reasons.push('ID_MX_VALID');
      break;
    case 'syntax_valid':
      identity = 10;
      reasons.push('ID_SYNTAX_ONLY');
      break;
    default:
      identity = 0;
      reasons.push('ID_UNVERIFIED');
  }
  if (input.is_disposable) reasons.push('ID_DISPOSABLE');
  if (input.syntax_valid === false && nonEmpty(input.email)) reasons.push('ID_BAD_SYNTAX');
  if (!nonEmpty(input.email) && !nonEmpty(input.phone_e164)) reasons.push('ID_NO_CONTACT');

  // ---- Completeness (0-15) ----
  let completeness = 0;
  if (nonEmpty(input.first_name) || nonEmpty(input.last_name)) completeness += 2;
  if (nonEmpty(input.company)) completeness += 3;
  if (nonEmpty(input.title)) completeness += 2;
  if (nonEmpty(input.phone_e164)) completeness += 3;
  if (nonEmpty(input.city) || nonEmpty(input.region)) completeness += 2;
  if (nonEmpty(input.linkedin_url) || nonEmpty(input.website) || nonEmpty(input.source_url)) {
    completeness += 3;
  }
  reasons.push(completeness >= 10 ? 'COMPLETENESS_OK' : 'COMPLETENESS_LOW');

  // ---- Source tier (0-20) ----
  const tier = classifySourceTier(input.source_kind, input.first_party);
  const tierPts = TIER_POINTS[tier];
  reasons.push(`SOURCE_TIER_${tier}`);

  // ---- ICP fit (0-15) ----
  let icp = 0;
  if (input.icp_segment && KNOWN_ICP_SEGMENTS.has(input.icp_segment)) {
    icp += 10;
    reasons.push('ICP_MATCH');
  } else {
    reasons.push('ICP_UNKNOWN');
  }
  const tags = (input.tags ?? []).map((t) => t.toLowerCase());
  const hasSignalTag = tags.some((t) =>
    ICP_TAG_SIGNALS.some((s) => t === s || t.includes(s))
  );
  if (hasSignalTag) {
    icp += 5;
    reasons.push('ICP_TAG_SIGNAL');
  }
  icp = Math.min(icp, 15);

  // ---- Freshness (0-10) ----
  const { pts: freshPts, code: freshCode } = freshnessPoints(input.last_verified_at);
  reasons.push(freshCode);

  // ---- Intent (0-5) ----
  let intent = 0;
  if ((input.rating ?? 0) >= 4.0) intent += 1;
  if ((input.rating_count ?? 0) >= 100) intent += 1;
  if ((input.rating_count ?? 0) >= 500) intent += 1;
  if (tags.includes('opted_in')) intent += 1;
  if (tags.includes('repeat_buyer')) intent += 1;
  intent = Math.min(intent, 5);
  if (intent >= 2) reasons.push('INTENT_SIGNAL');

  // ---- Compose + clamp ----
  const raw = identity + completeness + tierPts + icp + freshPts + intent;
  const quality_score = Math.max(0, Math.min(100, raw));

  // ---- Export eligibility ----
  const eligibility = decideEligibility({
    score: quality_score,
    verification,
    tier,
    input,
    reasons,
  });

  return {
    quality_score,
    verification_status: verification,
    source_tier: tier,
    export_eligibility: eligibility,
    reason_codes: reasons,
  };
}

interface EligibilityArgs {
  score: number;
  verification: VerificationStatus;
  tier: SourceTier;
  input: QualityInput;
  reasons: string[];
}

function decideEligibility(args: EligibilityArgs): ExportEligibility {
  const { score, verification, tier, input, reasons } = args;

  // Hard rejects: never eligible, never reviewable — suppressions are law.
  if (input.is_suppressed) {
    reasons.push('REJECT_SUPPRESSED');
    return 'rejected';
  }
  if (input.is_disposable) {
    reasons.push('REJECT_DISPOSABLE');
    return 'rejected';
  }
  if (input.reject_reason && HARD_REJECT_REASONS.has(input.reject_reason)) {
    reasons.push(`REJECT_${input.reject_reason.toUpperCase()}`);
    return 'rejected';
  }
  if (nonEmpty(input.email) && input.syntax_valid === false) {
    reasons.push('REJECT_BAD_SYNTAX');
    return 'rejected';
  }

  // Duplicates go to quarantine (not rejected) so operators can decide
  // whether the new record is richer than the stored one.
  if (input.is_duplicate) {
    reasons.push('QUARANTINE_DUPLICATE');
    return 'quarantine';
  }

  // No way to reach anyone — quarantine for operator decision.
  if (!nonEmpty(input.email) && !nonEmpty(input.phone_e164)) {
    reasons.push('QUARANTINE_NO_CONTACT');
    return 'quarantine';
  }

  // Scraped (tier D) rows never bypass the gate; they must be manually
  // promoted or re-verified through a tier-B enrichment pass first.
  if (tier === 'D' && verification !== 'smtp_verified' && verification !== 'first_party') {
    reasons.push('REVIEW_SCRAPED_UNVERIFIED');
    return 'review';
  }

  // Stale rows (last verified > 180 days ago) go to review until re-verified.
  if (reasons.includes('STALE')) {
    reasons.push('REVIEW_STALE');
    return 'review';
  }

  // Identity quality gate: we will not export anything we haven't at least
  // MX-checked, even if the score is high from firmographics.
  const identityOk =
    verification === 'mx_valid' ||
    verification === 'smtp_verified' ||
    verification === 'first_party';
  if (!identityOk && nonEmpty(input.email)) {
    reasons.push('REVIEW_IDENTITY_WEAK');
    return 'review';
  }

  // Score gate.
  if (score >= 70) {
    reasons.push('ELIGIBLE');
    return 'eligible';
  }
  if (score >= 40) {
    reasons.push('REVIEW_LOW_SCORE');
    return 'review';
  }
  reasons.push('QUARANTINE_LOW_SCORE');
  return 'quarantine';
}

/**
 * Convenience: build a QualityInput from a ScrubbedLead plus a
 * per-batch source kind. Keeps ingest call-sites to two lines.
 */
export function fromScrubbed(
  s: ScrubbedLead,
  opts: { source_kind?: SourceKind; first_party?: boolean; last_verified_at?: string | Date } = {}
): QualityInput {
  return {
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    is_disposable: s.is_disposable,
    is_duplicate: s.is_duplicate,
    is_suppressed: s.is_suppressed,
    reject_reason: s.reject_reason ?? null,
    email: s.normalized_email || null,
    phone_e164: s.phone_e164,
    first_name: s.first_name ?? null,
    last_name: s.last_name ?? null,
    company: s.company ?? null,
    title: s.title ?? null,
    city: s.city ?? null,
    region: s.region ?? null,
    country: s.country ?? null,
    linkedin_url: (s as { linkedin_url?: string }).linkedin_url ?? null,
    website: (s as { website?: string }).website ?? null,
    source_url: s.source_url ?? null,
    icp_segment: s.icp_segment ?? null,
    tags: s.tags ?? [],
    rating: (s as { raw_rating?: number }).raw_rating ?? null,
    rating_count: (s as { raw_rating_count?: number }).raw_rating_count ?? null,
    source_kind: opts.source_kind,
    first_party: opts.first_party,
    last_verified_at: opts.last_verified_at ?? new Date(),
  };
}

/**
 * Translate a quality verdict into the lead row columns our DB expects.
 * Callers spread this into the insert/upsert payload.
 */
export function toLeadColumns(verdict: QualityResult, at: Date = new Date()) {
  return {
    quality_score: verdict.quality_score,
    verification_status: verdict.verification_status,
    source_tier: verdict.source_tier,
    export_eligibility: verdict.export_eligibility,
    reason_codes: verdict.reason_codes,
    last_verified_at: at.toISOString(),
    // Keep is_scrubbed in sync with eligibility so old queries still work.
    is_scrubbed: verdict.export_eligibility === 'eligible',
  };
}
