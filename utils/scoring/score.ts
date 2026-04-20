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

export const SCORE_WEIGHTS = {
  identity: 0.3,
  icp_fit: 0.25,
  completeness: 0.2,
  freshness: 0.15,
  intent: 0.07,
  source_confidence: 0.03,
} as const;

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
}

/** Identity: is this a real, reachable person? */
function scoreIdentity(i: ScoreInput): number {
  if (i.is_suppressed || i.is_duplicate) return 0;
  let s = 0;
  if (i.syntax_valid) s += 0.25;
  if (i.mx_valid) s += 0.25;
  if (i.smtp_valid) s += 0.15;
  if (i.is_disposable === false) s += 0.1;
  if (i.phone_e164) s += 0.15;
  if (i.first_name && i.last_name) s += 0.1;
  return clamp01(s);
}

/** ICP fit: does this lead match the client's target segments? */
function scoreIcpFit(i: ScoreInput): number {
  const targets = (i.client_icp_targets ?? []).filter(Boolean);
  if (targets.length === 0) return 0.5; // unknown target — neutral
  if (!i.icp_segment) return 0.3; // lead has no segment — mild penalty
  return targets.includes(i.icp_segment) ? 1 : 0.2;
}

/** Completeness: what fraction of the key firmographic fields are populated? */
function scoreCompleteness(i: ScoreInput): number {
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
  return clamp01(filled / fields.length);
}

/** Freshness: linear decay from 1.0 (today) to 0.0 at 180 days. */
function scoreFreshness(i: ScoreInput): number {
  if (!i.verified_at) return 1; // just scrubbed, treat as fresh
  const t =
    i.verified_at instanceof Date ? i.verified_at.getTime() : new Date(i.verified_at).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1;
  if (ageDays >= 180) return 0;
  return clamp01(1 - ageDays / 180);
}

/** Intent: best-effort proxy until we have engagement data. */
function scoreIntent(i: ScoreInput): number {
  let s = 0.3; // baseline — no signal
  if (i.linkedin_url) s += 0.2;
  if (i.instagram_handle) s += 0.1;
  if (i.title && /founder|owner|ceo|director|vp|head|manager|buyer/i.test(i.title)) {
    s += 0.25;
  }
  if (i.company) s += 0.15;
  return clamp01(s);
}

/** Source confidence: map trust tier [1..5] to [1.0..0.3]. */
function scoreSourceConfidence(i: ScoreInput): number {
  const tier = i.source_trust_tier;
  if (tier == null) return 0.5;
  switch (tier) {
    case 1:
      return 1;
    case 2:
      return 0.85;
    case 3:
      return 0.7;
    case 4:
      return 0.5;
    case 5:
      return 0.3;
    default:
      return 0.5;
  }
}

export function scoreLead(input: ScoreInput): ScoreOutput {
  const identity_score = scoreIdentity(input);
  const icp_fit_score = scoreIcpFit(input);
  const completeness_score = scoreCompleteness(input);
  const freshness_score = scoreFreshness(input);
  const intent_score = scoreIntent(input);
  const source_confidence = scoreSourceConfidence(input);

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
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
