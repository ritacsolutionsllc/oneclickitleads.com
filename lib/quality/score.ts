/**
 * Canonical lead quality scoring engine for OneClickitLeads.
 *
 * Deterministic, side-effect free. Given the scrub output and source metadata,
 * returns a 0–100 quality score, reason codes explaining the score, a
 * verification status, a source tier, and the initial lead_status the record
 * should enter the system with.
 *
 * The goal: no record leaves the platform without a score, reason codes, and
 * an explicit workflow state. This helper is the ONE place that logic lives —
 * every ingest route funnels through it so scoring is consistent.
 *
 * Range: scores are clamped to 0..100.
 * Bands (documented; used by UI copy + export gating):
 *   0–39   rejected / quarantine
 *   40–59  review
 *   60–79  approved (export-eligible when other gates pass)
 *   80–100 high-confidence (export-priority)
 */
export type SourceKind =
  | 'firstparty'
  | 'apollo'
  | 'commonroom'
  | 'hunter'
  | 'enriched'
  | 'api'
  | 'purchased'
  | 'places'
  | 'osm'
  | 'scraped'
  | 'webscraping'
  | 'form'
  | string;

export type VerificationStatus =
  | 'unverified'
  | 'syntax_only'
  | 'mx_only'
  | 'smtp_verified'
  | 'first_party';

export type LeadStatus = 'review' | 'approved' | 'rejected';

export type ReasonCode =
  | 'first_party_optin'
  | 'email_verified_smtp'
  | 'email_verified_mx'
  | 'email_syntax_only'
  | 'email_bad_syntax'
  | 'email_disposable'
  | 'email_missing'
  | 'phone_present'
  | 'phone_missing'
  | 'name_present'
  | 'name_missing'
  | 'company_present'
  | 'company_missing'
  | 'title_missing'
  | 'location_present'
  | 'icp_set'
  | 'icp_missing'
  | 'intent_signal'
  | 'fresh_record'
  | 'stale_record'
  | 'duplicate'
  | 'suppressed'
  | 'source_first_party'
  | 'source_crm'
  | 'source_enriched'
  | 'source_directory'
  | 'source_scrape'
  | 'below_eligibility_floor'
  | 'no_identity';

export interface ScoreInput {
  // identity
  email?: string | null;
  phone_e164?: string | null;
  first_name?: string | null;
  last_name?: string | null;

  // firmographics
  company?: string | null;
  title?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;

  // segmentation
  icp_segment?: string | null;
  tags?: string[] | null;

  // scrub outcomes (from utils/scrub/pipeline.ts)
  syntax_valid?: boolean | null;
  mx_valid?: boolean | null;
  smtp_valid?: boolean | null;
  is_disposable?: boolean | null;
  is_duplicate?: boolean | null;
  is_suppressed?: boolean | null;
  reject_reason?: string | null;

  // provenance
  source_kind?: SourceKind | null;

  // intent hints
  rating?: number | null;
  rating_count?: number | null;

  // freshness
  created_at?: string | Date | null;
  verified_at?: string | Date | null;
}

export interface ScoringResult {
  quality_score: number;
  reason_codes: ReasonCode[];
  verification_status: VerificationStatus;
  source_tier: 1 | 2 | 3 | 4 | 5;
  lead_status: LeadStatus;
  export_eligible: boolean;
}

/** Lower = higher confidence. Mirrored in 0005_quality_first.sql backfill. */
export function sourceTierFor(kind: SourceKind | null | undefined): 1 | 2 | 3 | 4 | 5 {
  switch (kind) {
    case 'firstparty':
    case 'form':
      return 1;
    case 'apollo':
    case 'commonroom':
      return 2;
    case 'hunter':
    case 'enriched':
    case 'purchased':
    case 'api':
      return 3;
    case 'places':
    case 'osm':
      return 4;
    case 'scraped':
    case 'webscraping':
      return 5;
    default:
      return 5;
  }
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Score a lead. Pure function — no I/O, safe to call from any route, edge
 * function, or scheduled worker.
 */
export function scoreLead(input: ScoreInput): ScoringResult {
  const reasons: ReasonCode[] = [];
  const now = new Date();
  const source_tier = sourceTierFor(input.source_kind);

  // ---- Verification status ---------------------------------------------
  let verification_status: VerificationStatus = 'unverified';
  if (input.source_kind === 'firstparty') {
    verification_status = 'first_party';
    reasons.push('first_party_optin', 'source_first_party');
  } else if (input.smtp_valid) {
    verification_status = 'smtp_verified';
    reasons.push('email_verified_smtp');
  } else if (input.mx_valid) {
    verification_status = 'mx_only';
    reasons.push('email_verified_mx');
  } else if (input.syntax_valid) {
    verification_status = 'syntax_only';
    reasons.push('email_syntax_only');
  }

  // ---- Hard rejections -------------------------------------------------
  const hardReject =
    input.is_disposable === true ||
    input.reject_reason === 'bad_syntax' ||
    (!input.email && !input.phone_e164);

  if (input.is_disposable) reasons.push('email_disposable');
  if (input.reject_reason === 'bad_syntax') reasons.push('email_bad_syntax');
  if (!input.email) reasons.push('email_missing');
  if (!input.phone_e164) reasons.push('phone_missing');
  if (!input.email && !input.phone_e164) reasons.push('no_identity');
  if (input.is_duplicate) reasons.push('duplicate');
  if (input.is_suppressed) reasons.push('suppressed');

  if (hardReject) {
    return {
      quality_score: 0,
      reason_codes: dedupe(reasons),
      verification_status,
      source_tier,
      lead_status: 'rejected',
      export_eligible: false,
    };
  }
  if (input.is_duplicate || input.is_suppressed) {
    return {
      quality_score: 0,
      reason_codes: dedupe(reasons),
      verification_status,
      source_tier,
      lead_status: 'rejected',
      export_eligible: false,
    };
  }

  // ---- Composite score -------------------------------------------------
  let score = 0;

  // Verified identity (max 30)
  if (verification_status === 'smtp_verified' || verification_status === 'first_party') {
    score += 30;
  } else if (verification_status === 'mx_only') {
    score += 20;
  } else if (verification_status === 'syntax_only') {
    score += 10;
  }

  // Completeness (max 20)
  let completeness = 0;
  if (input.email) completeness += 5;
  if (input.phone_e164) { completeness += 3; reasons.push('phone_present'); }
  if (input.first_name) completeness += 2;
  if (input.last_name)  completeness += 2;
  if (input.first_name || input.last_name) reasons.push('name_present');
  else reasons.push('name_missing');
  if (input.company) { completeness += 3; reasons.push('company_present'); }
  else reasons.push('company_missing');
  if (input.title) completeness += 2;
  else reasons.push('title_missing');
  if (input.city || input.region || input.country) {
    completeness += 3;
    reasons.push('location_present');
  }
  score += Math.min(completeness, 20);

  // Source confidence (max 20)
  switch (source_tier) {
    case 1: score += 20; break;
    case 2: score += 15; reasons.push('source_crm'); break;
    case 3: score += 12; reasons.push('source_enriched'); break;
    case 4: score += 8;  reasons.push('source_directory'); break;
    case 5: score += 4;  reasons.push('source_scrape'); break;
  }

  // ICP fit (max 10)
  if (input.icp_segment && input.icp_segment.trim()) {
    score += 10;
    reasons.push('icp_set');
  } else {
    reasons.push('icp_missing');
  }

  // Intent signals (max 10)
  let intent = 0;
  if ((input.rating_count ?? 0) >= 50) intent += 5;
  if ((input.rating ?? 0) >= 4.5 && (input.rating_count ?? 0) >= 20) intent += 3;
  const tags = input.tags ?? [];
  if (tags.includes('repeat_buyer') || tags.includes('opted_in')) intent += 5;
  if (intent > 0) reasons.push('intent_signal');
  score += Math.min(intent, 10);

  // Freshness (max 10)
  const verifiedAt = toDate(input.verified_at);
  const createdAt = toDate(input.created_at) ?? now;
  const freshnessRef = verifiedAt ?? createdAt;
  const ageDays = daysBetween(now, freshnessRef);
  if (ageDays <= 30) {
    score += 10;
    reasons.push('fresh_record');
  } else if (ageDays <= 90) {
    score += 5;
  } else {
    reasons.push('stale_record');
  }

  const quality_score = Math.max(0, Math.min(100, Math.round(score)));

  // ---- Workflow state + export eligibility ----------------------------
  // Export gate: score floor + identity + no hard flags. Mirrored exactly
  // in the generated export_eligible column in Postgres.
  const hasIdentity = !!(input.email || input.phone_e164);
  const verifiedEnough =
    verification_status === 'smtp_verified' ||
    verification_status === 'mx_only' ||
    verification_status === 'first_party';
  const export_eligible =
    hasIdentity &&
    verifiedEnough &&
    !input.is_duplicate &&
    !input.is_suppressed &&
    !input.is_disposable &&
    quality_score >= 60;

  let lead_status: LeadStatus;
  if (quality_score < 40) {
    lead_status = 'rejected';
    reasons.push('below_eligibility_floor');
  } else if (export_eligible) {
    lead_status = 'approved';
  } else {
    lead_status = 'review';
  }

  return {
    quality_score,
    reason_codes: dedupe(reasons),
    verification_status,
    source_tier,
    lead_status,
    export_eligible,
  };
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Shape the scoring engine output into the column payload the leads table
 * expects. `export_eligible` is a generated column in Postgres, so it is
 * intentionally not in this payload.
 */
export function scoringColumns(result: ScoringResult, scoredAt: Date = new Date()) {
  return {
    quality_score: result.quality_score,
    reason_codes: result.reason_codes,
    verification_status: result.verification_status,
    source_tier: result.source_tier,
    lead_status: result.lead_status,
    last_scored_at: scoredAt.toISOString(),
  };
}
