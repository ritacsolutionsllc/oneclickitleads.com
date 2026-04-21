// Load per-client scoring context (ICP targets + export policy) in one query.
//
// Every ingestion route feeds this context into scrubBatch so the scoring
// engine sees the same inputs regardless of whether the row came from a CSV
// upload, a public scrape, or the consent form. Keeping the lookup here means
// route handlers stay thin and callers can't accidentally drop a field.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExportPolicy } from './tier';

export interface ClientScoringContext {
  id: string;
  icpTargets: string[];
  exportPolicy: ExportPolicy | null;
}

/**
 * Resolve a client row (by slug) + the scoring inputs the pipeline needs.
 * Returns `null` when the client doesn't exist so callers can 404 cleanly.
 */
export async function loadClientContext(
  supabase: SupabaseClient,
  slug: string
): Promise<ClientScoringContext | null> {
  const { data } = await supabase
    .from('clients')
    .select('id, icp_targets, export_policy')
    .eq('slug', slug)
    .single();
  if (!data) return null;
  return {
    id: data.id as string,
    icpTargets: Array.isArray(data.icp_targets) ? (data.icp_targets as string[]) : [],
    exportPolicy: (data.export_policy ?? null) as ExportPolicy | null,
  };
}

/** Source kind → trust tier mapping, centralized so routes stay consistent. */
export const SOURCE_TRUST_TIER: Record<string, number> = {
  firstparty: 1,
  consent: 1,
  apollo: 2,
  commonroom: 2,
  enriched: 3,
  scraped: 4,
  purchased: 4,
  social: 5,
};

export function trustTierForKind(kind: string | null | undefined, fallback = 4): number {
  if (!kind) return fallback;
  return SOURCE_TRUST_TIER[kind] ?? fallback;
}
