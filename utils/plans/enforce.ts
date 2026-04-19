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
    .select('plan, clean_this_month, export_eligible_this_month, monthly_cap')
    .eq('client_id', clientId)
    .single();
  if (error || !data) {
    return { ok: false as const, reason: 'usage row not found', used: 0, cap: 0, plan: 'starter' };
  }
  const plan = planByTier(data.plan);
  // Quality-first: the cap counts export-eligible leads (the ones that
  // actually left the building), not raw "clean" rows. Falls back to
  // clean_this_month on older rows where the view column may be null.
  const used = Number(data.export_eligible_this_month ?? data.clean_this_month ?? 0);
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
