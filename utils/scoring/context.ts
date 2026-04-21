// Per-client scoring context used by every ingestion path.
//
// Scoring and tier assignment both need the client's target ICP segments
// (drives icp_fit_score) and export policy (drives min_composite_score floor
// and which tiers are allowed to ship). Previously each ingest route loaded
// `clients.id` only, so scrubBatch fell back to neutral defaults — meaning
// ICP fit and per-client floors weren't actually applied. This helper
// centralizes the load so new ingestion paths can't forget.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExportPolicy } from './tier';

export interface ClientScoringContext {
  clientId: string;
  icpTargets: string[];
  exportPolicy: ExportPolicy | null;
}

interface ClientRow {
  id: string;
  icp_targets: string[] | null;
  export_policy: ExportPolicy | null;
}

/**
 * Resolve a client slug to the full scoring context. Returns null if the
 * client doesn't exist. Callers should 404 on null.
 */
export async function loadClientScoringContextBySlug(
  supabase: SupabaseClient,
  slug: string
): Promise<ClientScoringContext | null> {
  const { data } = await supabase
    .from('clients')
    .select('id, icp_targets, export_policy')
    .eq('slug', slug)
    .single<ClientRow>();
  return data ? rowToContext(data) : null;
}

/**
 * Resolve a client id to the full scoring context. Returns null if the
 * client doesn't exist.
 */
export async function loadClientScoringContextById(
  supabase: SupabaseClient,
  clientId: string
): Promise<ClientScoringContext | null> {
  const { data } = await supabase
    .from('clients')
    .select('id, icp_targets, export_policy')
    .eq('id', clientId)
    .single<ClientRow>();
  return data ? rowToContext(data) : null;
}

function rowToContext(row: ClientRow): ClientScoringContext {
  return {
    clientId: row.id,
    icpTargets: (row.icp_targets ?? []).filter((t): t is string => typeof t === 'string' && !!t),
    exportPolicy: row.export_policy ?? null,
  };
}
