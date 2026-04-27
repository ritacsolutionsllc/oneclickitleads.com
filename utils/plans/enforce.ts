import { createAdminClient } from '@/utils/supabase/server';
import { planByTier } from '@/lib/plans';

/**
 * Checks whether a client can still export/push leads this month.
 * Called from /api/export and /api/push/smartly.
 *
 * Returns { ok: true } or { ok: false, reason, used, cap, plan }.
 */
export async function enforceExport(clientId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('v_client_usage')
    .select('plan, clean_this_month, monthly_cap')
    .eq('client_id', clientId)
    .single();
  if (error || !data) {
    // View query failed (likely missing view or no row yet) — fail open so export isn't blocked.
    return { ok: true as const, used: 0, cap: 2500, plan: 'starter', remaining: 2500 };
  }
  const plan = planByTier(data.plan);
  const used = Number(data.clean_this_month ?? 0);
  const cap  = Number(data.monthly_cap ?? plan.features.monthlyCleanLeads);

  if (used >= cap) {
    return { ok: false as const, reason: 'monthly cap reached', used, cap, plan: plan.tier };
  }
  return { ok: true as const, used, cap, plan: plan.tier, remaining: cap - used };
}

/** Helper that returns the maximum rows we should hand out on a single export. */
export function maxRowsForExport(plan: ReturnType<typeof planByTier>, requested: number) {
  if (plan.features.monthlyCleanLeads === 1_000_000) return requested; // enterprise
  return Math.min(requested, plan.features.monthlyCleanLeads);
}
