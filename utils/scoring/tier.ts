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

/**
 * Assign a tier to a lead. Suppressed/duplicate leads are forced to `discard`
 * regardless of score. Unscrubbed leads land in `hold` so they don't export
 * until the scrub pipeline has run.
 */
export function assignTier(input: TierInput): ExportTier {
  if (input.is_suppressed || input.is_duplicate) return 'discard';
  if (input.is_scrubbed === false) return 'hold';

  const s = input.composite_score;
  const floor = input.policy?.min_composite_score ?? DEFAULT_EXPORT_POLICY.min_composite_score;

  if (!Number.isFinite(s) || s < Math.min(20, floor)) return 'discard';
  if (s >= 80) return 'premium';
  if (s >= 65) return 'standard';
  if (s >= 50) return 'prospecting';
  if (s >= 35) return 'review';
  if (s >= 20) return 'hold';
  return 'discard';
}

/** Which tiers a client's policy allows to export automatically. */
export function allowedTiers(policy?: ExportPolicy | null): ExportTier[] {
  const p = { ...DEFAULT_EXPORT_POLICY, ...(policy ?? {}) };
  const tiers: ExportTier[] = ['premium', 'standard', 'prospecting', 'review', 'hold', 'discard'];
  return tiers.filter((t) => p[t] === 'allow');
}

/** Whether a given tier can export under the policy. `manual` and `block` both
 *  return false — callers decide whether to surface the review queue separately. */
export function canAutoExport(tier: ExportTier, policy?: ExportPolicy | null): boolean {
  const p = { ...DEFAULT_EXPORT_POLICY, ...(policy ?? {}) };
  return p[tier] === 'allow';
}
