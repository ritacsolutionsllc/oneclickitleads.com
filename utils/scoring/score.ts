// Quality scoring: compute the six sub-scores that feed composite_score.
//
// Each sub-score is in [0, 1]. The DB stores these on `leads` and derives
// composite_score as a generated column using these weights (see
// supabase/migrations/0005_quality_first.sql). We replicate the weights here
// so callers can preview a composite before persisting, but the DB is the
// source of truth.
//
// Weights (sum to 1.0):
//   identity          0.30
//   icp_fit           0.25
//   completeness      0.20
//   freshness         0.15
//   intent            0.07
//   source_confidence 0.03
//
// Every scoring decision also emits a stable `reason_code` so the UI /
// /dashboard/quality + /dashboard/leads can explain why a lead landed where
// it did. Reason codes are append-only — never rename one without a
// migration, because they are persisted on `leads.reason_codes`.

export const SCORE_WEIGHTS = {
  identity: 0.3,
  icp_fit: 0.25,
  completeness: 0.2,
  freshness: 0.15,
  intent: 0.07,
  source_confidence: 0.03,
} as const;

/**
 * Stable reason codes. Keep sorted by category; add new ones, never mutate
 * existing ones (they are persisted on `leads.reason_codes`).
 */
export const REASON = {
  // identity
  IDENTITY_SUPPRESSED: 'identity_suppressed',
  IDENTITY_DUPLICATE: 'identity_duplicate',
  IDENTITY_NO_MX: 'identity_no_mx',
  IDENTITY_NO_SMTP: 'identity_no_smtp',
  IDENTITY_DISPOSABLE: 'identity_disposable',
  IDENTITY_BAD_SYNTAX: 'identity_bad_syntax',
  IDENTITY_VERIFIED_EMAIL: 'identity_verified_email',
  IDENTITY_HAS_PHONE: 'identity_has_phone',
  IDENTITY_HAS_NAME: 'identity_has_name',
  // icp
  ICP_MATCH: 'icp_match',
  ICP_MISMATCH: 'icp_mismatch',
  ICP_UNKNOWN_SEGMENT: 'icp_unknown_segment',
  ICP_NO_TARGETS_CONFIGURED: 'icp_no_targets_configured',
  // completeness
  COMPLETENESS_LOW: 'completeness_low',
  COMPLETENESS_MEDIUM: 'completeness_medium',
  COMPLETENESS_HIGH: 'completeness_high',
  // freshness
  FRESHNESS_NEW: 'freshness_new',
  FRESHNESS_STALE: 'freshness_stale',
  FRESHNESS_EXPIRED: 'freshness_expired',
  // intent
  INTENT_BUYER_TITLE: 'intent_buyer_title',
  INTENT_HAS_SOCIAL: 'intent_has_social',
  INTENT_NONE: 'intent_none',
  // source
  SOURCE_FIRSTPARTY: 'source_firstparty',
  SOURCE_API_VERIFIED: 'source_api_verified',
  SOURCE_ENRICHED: 'source_enriched',
  SOURCE_PUBLIC_SCRAPED: 'source_public_scraped',
  SOURCE_SOCIAL_SPECULATIVE: 'source_social_speculative',
  SOURCE_UNKNOWN_TIER: 'source_unknown_tier',
} as const;

export type ReasonCode = (typeof REASON)[keyof typeof REASON];

export interface ScoreInput {
  // Email/phone verification state (from the scrub pipeline).
  syntax_valid?: boolean;
  mx_valid?: boolean;
  smtp_valid?: boolean;
  is_disposable?: boolean;
  is_duplicate?: boolean;
  is_suppressed?: boolean;

  // Identifiers / completeness fields.
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

  // ICP fit.
  icp_segment?: string | null;
  client_icp_targets?: string[] | null;

  // Freshness: when this lead was last verified against an external provider.
  // null => treat as "just now" (scrub-time verification counts).
  verified_at?: Date | string | null;

  // Source trust tier: 1 (best, first-party opt-in) .. 5 (worst, social).
  source_trust_tier?: number | null;
}

export interface ScoreOutput {
  identity_score: number;
  icp_fit_score: number;
  completeness_score: number;
  freshness_score: number;
  intent_score: number;
  source_confidence: number;
  /** 0..100, matches DB composite_score generated column. */
  composite_score: number;
  /** Stable tags explaining the score. Persisted on `leads.reason_codes`. */
  reason_codes: ReasonCode[];
}

/** Identity: is this a real, reachable person? */
function scoreIdentity(i: ScoreInput, reasons: Set<ReasonCode>): number {
  if (i.is_suppressed) {
    reasons.add(REASON.IDENTITY_SUPPRESSED);
    return 0;
  }
  if (i.is_duplicate) {
    reasons.add(REASON.IDENTITY_DUPLICATE);
    return 0;
  }
  let s = 0;
  if (i.syntax_valid === false) reasons.add(REASON.IDENTITY_BAD_SYNTAX);
  if (i.syntax_valid) s += 0.25;
  if (i.mx_valid) s += 0.25;
  else if (i.email) reasons.add(REASON.IDENTITY_NO_MX);
  if (i.smtp_valid) {
    s += 0.15;
    reasons.add(REASON.IDENTITY_VERIFIED_EMAIL);
  } else if (i.email && i.mx_valid) {
    reasons.add(REASON.IDENTITY_NO_SMTP);
  }
  if (i.is_disposable === true) reasons.add(REASON.IDENTITY_DISPOSABLE);
  if (i.is_disposable === false) s += 0.1;
  if (i.phone_e164) {
    s += 0.15;
    reasons.add(REASON.IDENTITY_HAS_PHONE);
  }
  if (i.first_name && i.last_name) {
    s += 0.1;
    reasons.add(REASON.IDENTITY_HAS_NAME);
  }
  return clamp01(s);
}

/** ICP fit: does this lead match the client's target segments? */
function scoreIcpFit(i: ScoreInput, reasons: Set<ReasonCode>): number {
  const targets = (i.client_icp_targets ?? []).filter(Boolean);
  if (targets.length === 0) {
    reasons.add(REASON.ICP_NO_TARGETS_CONFIGURED);
    return 0.5; // unknown target — neutral
  }
  if (!i.icp_segment) {
    reasons.add(REASON.ICP_UNKNOWN_SEGMENT);
    return 0.3; // lead has no segment — mild penalty
  }
  if (targets.includes(i.icp_segment)) {
    reasons.add(REASON.ICP_MATCH);
    return 1;
  }
  reasons.add(REASON.ICP_MISMATCH);
  return 0.2;
}

/** Completeness: what fraction of the key firmographic fields are populated? */
function scoreCompleteness(i: ScoreInput, reasons: Set<ReasonCode>): number {
  const fields = [
    i.email,
    i.phone_e164,
    i.first_name,
    i.last_name,
    i.company,
    i.title,
    i.city,
    i.country,
    i.linkedin_url ?? i.instagram_handle, // one social is enough
  ];
  const filled = fields.filter((v) => v != null && String(v).trim() !== '').length;
  const ratio = clamp01(filled / fields.length);
  if (ratio >= 0.75) reasons.add(REASON.COMPLETENESS_HIGH);
  else if (ratio >= 0.4) reasons.add(REASON.COMPLETENESS_MEDIUM);
  else reasons.add(REASON.COMPLETENESS_LOW);
  return ratio;
}

/** Freshness: linear decay from 1.0 (today) to 0.0 at 180 days. */
function scoreFreshness(i: ScoreInput, reasons: Set<ReasonCode>): number {
  if (!i.verified_at) {
    reasons.add(REASON.FRESHNESS_NEW);
    return 1;
  }
  const t =
    i.verified_at instanceof Date ? i.verified_at.getTime() : new Date(i.verified_at).getTime();
  if (!Number.isFinite(t)) {
    reasons.add(REASON.FRESHNESS_EXPIRED);
    return 0;
  }
  const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) {
    reasons.add(REASON.FRESHNESS_NEW);
    return 1;
  }
  if (ageDays >= 180) {
    reasons.add(REASON.FRESHNESS_EXPIRED);
    return 0;
  }
  if (ageDays >= 90) reasons.add(REASON.FRESHNESS_STALE);
  else reasons.add(REASON.FRESHNESS_NEW);
  return clamp01(1 - ageDays / 180);
}

/** Intent: best-effort proxy until we have engagement data. */
function scoreIntent(i: ScoreInput, reasons: Set<ReasonCode>): number {
  let s = 0.3; // baseline — no signal
  let signal = false;
  if (i.linkedin_url || i.instagram_handle) {
    s += i.linkedin_url ? 0.2 : 0.1;
    reasons.add(REASON.INTENT_HAS_SOCIAL);
    signal = true;
  }
  if (i.title && /founder|owner|ceo|director|vp|head|manager|buyer/i.test(i.title)) {
    s += 0.25;
    reasons.add(REASON.INTENT_BUYER_TITLE);
    signal = true;
  }
  if (i.company) s += 0.15;
  if (!signal) reasons.add(REASON.INTENT_NONE);
  return clamp01(s);
}

/** Source confidence: map trust tier [1..5] to [1.0..0.3]. */
function scoreSourceConfidence(i: ScoreInput, reasons: Set<ReasonCode>): number {
  const tier = i.source_trust_tier;
  if (tier == null) {
    reasons.add(REASON.SOURCE_UNKNOWN_TIER);
    return 0.5;
  }
  switch (tier) {
    case 1:
      reasons.add(REASON.SOURCE_FIRSTPARTY);
      return 1;
    case 2:
      reasons.add(REASON.SOURCE_API_VERIFIED);
      return 0.85;
    case 3:
      reasons.add(REASON.SOURCE_ENRICHED);
      return 0.7;
    case 4:
      reasons.add(REASON.SOURCE_PUBLIC_SCRAPED);
      return 0.5;
    case 5:
      reasons.add(REASON.SOURCE_SOCIAL_SPECULATIVE);
      return 0.3;
    default:
      reasons.add(REASON.SOURCE_UNKNOWN_TIER);
      return 0.5;
  }
}

export function scoreLead(input: ScoreInput): ScoreOutput {
  const reasons = new Set<ReasonCode>();

  const identity_score = scoreIdentity(input, reasons);
  const icp_fit_score = scoreIcpFit(input, reasons);
  const completeness_score = scoreCompleteness(input, reasons);
  const freshness_score = scoreFreshness(input, reasons);
  const intent_score = scoreIntent(input, reasons);
  const source_confidence = scoreSourceConfidence(input, reasons);

  const composite_score =
    (identity_score * SCORE_WEIGHTS.identity +
      icp_fit_score * SCORE_WEIGHTS.icp_fit +
      completeness_score * SCORE_WEIGHTS.completeness +
      freshness_score * SCORE_WEIGHTS.freshness +
      intent_score * SCORE_WEIGHTS.intent +
      source_confidence * SCORE_WEIGHTS.source_confidence) *
    100;

  return {
    identity_score,
    icp_fit_score,
    completeness_score,
    freshness_score,
    intent_score,
    source_confidence,
    composite_score,
    reason_codes: [...reasons],
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
