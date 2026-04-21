// Export tier assignment: map a composite_score (0..100) + per-client
// export_policy to a coarse tier used by /api/export and /api/push/*.
//
// The six tiers are a client-facing vocabulary — reviewers in the dashboard
// should see "standard" rather than "score 67". Tier bands are fixed; the
// client's policy controls which tiers actually ship to destinations.

export type ExportTier =
  | 'premium'       // >= 80: ship automatically, premium audiences
  | 'standard'      // >= 65: ship automatically
  | 'prospecting'   // >= 50: ship to prospecting-only audiences
  | 'review'        // >= 35: goes to the review queue, manual approval
  | 'hold'          // >= 20: held back, not exported
  | 'discard';      // < 20 or suppressed/duplicate: never export

export type TierAction = 'allow' | 'manual' | 'block';

/** Operator decision stored on `leads.review_state`. */
export type ReviewState = 'auto' | 'pending' | 'approved' | 'rejected' | 'needs_reverify';

export interface ExportPolicy {
  premium?: TierAction;
  standard?: TierAction;
  prospecting?: TierAction;
  review?: TierAction;
  hold?: TierAction;
  discard?: TierAction;
  /** Hard floor: any lead below this composite is forced to `discard`. */
  min_composite_score?: number;
}

export const DEFAULT_EXPORT_POLICY: Required<ExportPolicy> = {
  premium: 'allow',
  standard: 'allow',
  prospecting: 'allow',
  review: 'manual',
  hold: 'block',
  discard: 'block',
  min_composite_score: 50,
};

export interface TierInput {
  composite_score: number;
  is_suppressed?: boolean;
  is_duplicate?: boolean;
  is_scrubbed?: boolean;
  policy?: ExportPolicy | null;
}

export interface TierResult {
  tier: ExportTier;
  review_state: ReviewState;
  reason_codes: string[];
}

/**
 * Backwards-compatible helper: returns just the tier (what the DB column
 * stores). New callers should prefer `assignTierWithReason` so they can
 * persist the review_state + reason codes.
 */
export function assignTier(input: TierInput): ExportTier {
  return assignTierWithReason(input).tier;
}

/**
 * Assign a tier + initial review_state + tier-level reason codes.
 *
 * Rules:
 *  - Suppressed/duplicate → `discard` + `rejected` (never ships).
 *  - Unscrubbed → `hold` (the scrub pipeline runs next; we don't auto-ship).
 *  - Below the client's `min_composite_score` → forced `discard`.
 *  - Score-based bands: 80+ premium, 65+ standard, 50+ prospecting, 35+
 *    review, 20+ hold, else discard.
 *  - `review` tier starts life as `pending` so the review queue picks it up.
 *  - Every other tier starts as `auto` (tier is authoritative).
 */
export function assignTierWithReason(input: TierInput): TierResult {
  const reasons: string[] = [];

  if (input.is_suppressed) {
    reasons.push('tier_suppressed');
    return { tier: 'discard', review_state: 'rejected', reason_codes: reasons };
  }
  if (input.is_duplicate) {
    reasons.push('tier_duplicate');
    return { tier: 'discard', review_state: 'rejected', reason_codes: reasons };
  }
  if (input.is_scrubbed === false) {
    reasons.push('tier_unscrubbed');
    return { tier: 'hold', review_state: 'auto', reason_codes: reasons };
  }

  const s = input.composite_score;
  const floor = input.policy?.min_composite_score ?? DEFAULT_EXPORT_POLICY.min_composite_score;

  if (!Number.isFinite(s)) {
    reasons.push('tier_missing_score');
    return { tier: 'discard', review_state: 'rejected', reason_codes: reasons };
  }

  // Below the policy floor is treated as discard regardless of the score band.
  if (s < Math.min(20, floor)) {
    reasons.push('tier_below_policy_floor');
    return { tier: 'discard', review_state: 'rejected', reason_codes: reasons };
  }
  if (s < floor && s >= 20) {
    // Score would otherwise land in hold/review, but policy floor overrides.
    reasons.push('tier_below_policy_floor');
    return { tier: 'hold', review_state: 'auto', reason_codes: reasons };
  }

  let tier: ExportTier;
  if (s >= 80) tier = 'premium';
  else if (s >= 65) tier = 'standard';
  else if (s >= 50) tier = 'prospecting';
  else if (s >= 35) tier = 'review';
  else if (s >= 20) tier = 'hold';
  else tier = 'discard';

  reasons.push(`tier_${tier}`);
  const review_state: ReviewState = tier === 'review' ? 'pending' : 'auto';
  return { tier, review_state, reason_codes: reasons };
}

/** Which tiers a client's policy allows to export automatically. */
export function allowedTiers(policy?: ExportPolicy | null): ExportTier[] {
  const p = { ...DEFAULT_EXPORT_POLICY, ...(policy ?? {}) };
  const tiers: ExportTier[] = ['premium', 'standard', 'prospecting', 'review', 'hold', 'discard'];
  return tiers.filter((t) => p[t] === 'allow');
}

/** Which tiers a client's policy sends to manual review. */
export function manualTiers(policy?: ExportPolicy | null): ExportTier[] {
  const p = { ...DEFAULT_EXPORT_POLICY, ...(policy ?? {}) };
  const tiers: ExportTier[] = ['premium', 'standard', 'prospecting', 'review', 'hold', 'discard'];
  return tiers.filter((t) => p[t] === 'manual');
}

/** Whether a given tier can export under the policy. `manual` and `block` both
 *  return false — callers decide whether to surface the review queue separately. */
export function canAutoExport(tier: ExportTier, policy?: ExportPolicy | null): boolean {
  const p = { ...DEFAULT_EXPORT_POLICY, ...(policy ?? {}) };
  return p[tier] === 'allow';
}
