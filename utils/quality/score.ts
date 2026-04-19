// Canonical lead quality scoring engine.
//
// Every lead that enters the system — ingest, scrape, enrich, first-party
// form — runs through `scoreLead()` exactly once. The output is:
//
//   - `quality_score` (0-100, clamped) — the number UI surfaces and plan
//     caps count.
//   - `quality_reasons[]` — reason codes (stable, machine-readable) the UI
//     turns into human copy.
//   - `review_state` — where the record lands: approved | review | quarantined.
//   - `export_eligible` — hard gate for /api/export and /api/push/smartly.
//
// Rules in one place so routes stay thin and the gating policy is auditable.

export type SourceTier =
  | 'tier_1_verified' // first-party opt-in, SMTP-verified, manual whitelist
  | 'tier_2_enriched' // Apollo / Hunter / paid directories with confidence ≥ 70
  | 'tier_3_public'   // Google Places, OSM, other public business directories
  | 'tier_4_scraped'; // raw web scrape, needs human eyes

export type ReviewState =
  | 'pending'
  | 'approved'
  | 'review'
  | 'quarantined'
  | 'discarded';

export interface ScoreInput {
  // Identity checks from the scrub pipeline
  syntax_valid?: boolean;
  mx_valid?: boolean;
  smtp_valid?: boolean;
  is_disposable?: boolean;
  is_duplicate?: boolean;
  is_suppressed?: boolean;

  // Contact fields
  email?: string | null;
  phone_e164?: string | null;

  // Completeness
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;

  // ICP + segment
  icp_segment?: string | null;
  tags?: string[] | null;

  // Source lineage
  source_tier?: SourceTier;
  source_confidence?: number; // 0-100

  // Intent signals (Google Places rating × count is the most common today)
  rating?: number | null;
  rating_count?: number | null;

  // Freshness
  verified_at?: Date | string | null;
  ingested_at?: Date | string | null;
}

export interface ScoreResult {
  score: number;            // 0-100, clamped
  reasons: string[];        // stable reason codes
  source_tier: SourceTier;  // resolved tier (defaults to tier_4_scraped)
  review_state: ReviewState;
  export_eligible: boolean;
  verified_at: string | null; // ISO — set when we can call this verified
}

/** Minimum score required to land in 'approved' and be export-eligible. */
export const APPROVE_THRESHOLD = 60;

/** Known ICP segments for Chella + future clients. */
const KNOWN_SEGMENTS = new Set([
  'b2c_beauty',
  'salon',
  'retailer',
  'influencer',
  'mua',
]);

/** Hard disqualifiers. Any of these force quarantine regardless of score. */
function disqualifiers(input: ScoreInput): string[] {
  const out: string[] = [];
  if (input.is_suppressed) out.push('suppressed');
  if (input.is_duplicate) out.push('duplicate');
  if (input.is_disposable) out.push('disposable_domain');
  if (input.email && input.syntax_valid === false) out.push('bad_syntax');
  const noEmail = !input.email;
  const noPhone = !input.phone_e164;
  if (noEmail && noPhone) out.push('no_contact');
  return out;
}

function daysSince(ts: Date | string | null | undefined): number | null {
  if (!ts) return null;
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function tierBonus(tier: SourceTier): { bonus: number; reason: string } {
  switch (tier) {
    case 'tier_1_verified':
      return { bonus: 20, reason: 'source_tier_1_verified' };
    case 'tier_2_enriched':
      return { bonus: 10, reason: 'source_tier_2_enriched' };
    case 'tier_3_public':
      return { bonus: 5, reason: 'source_tier_3_public' };
    case 'tier_4_scraped':
      return { bonus: 0, reason: 'source_tier_4_scraped' };
  }
}

export function scoreLead(input: ScoreInput): ScoreResult {
  const reasons: string[] = [];
  const tier: SourceTier = input.source_tier ?? 'tier_4_scraped';

  // 1. Hard disqualifiers → quarantine immediately.
  const dq = disqualifiers(input);
  if (dq.length) {
    return {
      score: 0,
      reasons: dq,
      source_tier: tier,
      review_state: 'quarantined',
      export_eligible: false,
      verified_at: null,
    };
  }

  let score = 0;

  // 2. Identity verification — the single biggest signal.
  if (input.smtp_valid) {
    score += 30;
    reasons.push('smtp_verified');
  } else if (input.mx_valid) {
    score += 15;
    reasons.push('mx_valid_unverified');
  } else if (input.email) {
    reasons.push('email_unverified');
  }
  if (input.phone_e164) {
    score += 5;
    reasons.push('phone_present');
  }

  // 3. Completeness (cap at 20).
  const completenessFields = [
    input.first_name,
    input.last_name,
    input.company,
    input.title,
    input.city,
  ].filter(Boolean).length;
  const completenessBonus = Math.min(20, completenessFields * 4);
  if (completenessBonus > 0) {
    score += completenessBonus;
    reasons.push(`completeness_${completenessFields}_of_5`);
  }

  // 4. ICP fit.
  if (input.icp_segment) {
    score += 5;
    reasons.push('icp_segment_set');
    if (KNOWN_SEGMENTS.has(input.icp_segment)) {
      score += 5;
      reasons.push(`icp_known_${input.icp_segment}`);
    }
  }

  // 5. Intent signals — Google Places rating × count.
  const rating = input.rating ?? 0;
  const ratingCount = input.rating_count ?? 0;
  if (rating > 0 && ratingCount > 0) {
    const intent =
      Math.min(10, Math.max(0, (rating - 4) * 5)) +
      Math.min(5, ratingCount / 50);
    if (intent > 0) {
      score += intent;
      reasons.push(`intent_rating_${rating.toFixed(1)}x${ratingCount}`);
    }
  }

  // 6. Source confidence (tier + provider score).
  const { bonus, reason } = tierBonus(tier);
  score += bonus;
  reasons.push(reason);
  if (typeof input.source_confidence === 'number') {
    const confBonus = Math.min(10, Math.max(0, (input.source_confidence - 50) / 5));
    if (confBonus > 0) {
      score += confBonus;
      reasons.push('source_confidence_high');
    }
  }

  // 7. Freshness — prefer recently verified records.
  const freshnessDays =
    daysSince(input.verified_at) ?? daysSince(input.ingested_at);
  if (freshnessDays !== null) {
    if (freshnessDays <= 30) {
      score += 5;
      reasons.push('freshness_recent');
    } else if (freshnessDays > 90) {
      score -= 5;
      reasons.push('freshness_stale');
    }
  }

  score = clamp(score);

  // 8. Decide review state + eligibility.
  // Scraped records without SMTP verification stay in review even if the
  // score crosses the threshold — the whole point of the quality gate is
  // that scraped data never silently reaches a client.
  const scrapedUnverified =
    tier === 'tier_4_scraped' && !input.smtp_valid;
  if (scrapedUnverified) {
    reasons.push('scraped_unverified');
  }

  const passThreshold = score >= APPROVE_THRESHOLD;
  let review_state: ReviewState;
  let export_eligible: boolean;

  if (!passThreshold) {
    review_state = 'review';
    export_eligible = false;
    reasons.push('below_threshold');
  } else if (scrapedUnverified) {
    review_state = 'review';
    export_eligible = false;
  } else {
    review_state = 'approved';
    export_eligible = true;
  }

  const verifiedAt =
    input.smtp_valid || tier === 'tier_1_verified'
      ? (typeof input.verified_at === 'string'
          ? input.verified_at
          : input.verified_at instanceof Date
            ? input.verified_at.toISOString()
            : new Date().toISOString())
      : null;

  return {
    score,
    reasons,
    source_tier: tier,
    review_state,
    export_eligible,
    verified_at: verifiedAt,
  };
}

/**
 * Resolve the source tier from a `sources.kind` string. Used by ingest
 * routes that don't explicitly pass a tier.
 */
export function tierFromSourceKind(kind: string | null | undefined): SourceTier {
  switch ((kind ?? '').toLowerCase()) {
    case 'firstparty':
    case 'first_party':
      return 'tier_1_verified';
    case 'apollo':
    case 'commonroom':
    case 'common_room':
    case 'hunter':
    case 'zoominfo':
    case 'purchased':
      return 'tier_2_enriched';
    case 'places':
    case 'google_places':
    case 'osm':
    case 'overpass':
      return 'tier_3_public';
    case 'scraped':
    case 'webscrapingai':
    case 'webscraping_ai':
    case 'scrapingbee':
    case 'brightdata':
      return 'tier_4_scraped';
    case 'api':
    case 'ingest':
      return 'tier_2_enriched';
    default:
      return 'tier_4_scraped';
  }
}
