import { createAdminClient } from '@/utils/supabase/server';
import { planByTier, type PlanTier } from '@/lib/plans';

/**
 * Per-tier minimum quality score a lead must clear *in addition to*
 * being marked `export_eligibility = 'eligible'` by the scoring engine.
 *
 * The eligibility flag is the canonical gate; this floor is a second
 * line of defense that lets us shape what each tier ships:
 *   - Starter ships only highly-verified leads (the deliverability bar).
 *   - Growth opens the gate to MX-valid + verified-directory rows.
 *   - Agency/Enterprise can ship anything the engine marked eligible.
 */
export const TIER_MIN_QUALITY: Record<PlanTier, number> = {
  starter:    75,
  growth:     65,
  agency:     55,
  enterprise: 50,
};

export function minQualityForTier(tier: PlanTier | string | null | undefined): number {
  const t = (tier ?? 'starter') as PlanTier;
  return TIER_MIN_QUALITY[t] ?? TIER_MIN_QUALITY.starter;
}

/**
 * Checks whether a client can still export/push leads this month.
 * Called from /api/export and /api/push/smartly.
 *
 * Returns { ok: true } or { ok: false, reason, used, cap, plan }.
 *
 * `used` is keyed off `eligible_this_month` so a client never gets
 * billed for quarantined or review-state rows.
 */
export async function enforceExport(clientId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('v_client_usage')
    .select('plan, eligible_this_month, clean_this_month, monthly_cap')
    .eq('client_id', clientId)
    .single();
  if (error || !data) {
    return { ok: false as const, reason: 'usage row not found', used: 0, cap: 0, plan: 'starter' as const };
  }
  const plan = planByTier(data.plan);
  // Prefer the new eligibility-based count; fall back to clean_this_month
  // for clients whose rows were ingested before migration 0005.
  const used =
    Number(data.eligible_this_month ?? data.clean_this_month ?? 0);
  const cap  = Number(data.monthly_cap ?? plan.features.monthlyCleanLeads);

  if (used >= cap) {
    return {
      ok: false as const,
      reason: 'monthly cap reached',
      used,
      cap,
      plan: plan.tier,
    };
  }
  return {
    ok: true as const,
    used,
    cap,
    plan: plan.tier,
    remaining: cap - used,
    minQuality: minQualityForTier(plan.tier),
  };
}

/** Helper that returns the maximum rows we should hand out on a single export. */
export function maxRowsForExport(plan: ReturnType<typeof planByTier>, requested: number) {
  if (plan.features.monthlyCleanLeads === 1_000_000) return requested; // enterprise
  return Math.min(requested, plan.features.monthlyCleanLeads);
}
