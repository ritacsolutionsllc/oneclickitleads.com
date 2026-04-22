// Per-tenant scoring context: ICP targets + export policy.
//
// Loaded once per ingest batch and threaded through `scrubBatch` so every
// row in the batch is scored against the same client config — no
// route-by-route hard-coding.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExportPolicy } from './tier';

export interface ClientScoringContext {
  clientId: string;
  clientSlug?: string;
  icpTargets: string[];
  exportPolicy: ExportPolicy | null;
}

interface ClientRow {
  id: string;
  slug?: string | null;
  icp_targets?: string[] | null;
  export_policy?: ExportPolicy | null;
}

/** Look up scoring context by internal client UUID. */
export async function loadClientScoringContext(
  supabase: SupabaseClient,
  clientId: string
): Promise<ClientScoringContext | null> {
  const { data } = await supabase
    .from('clients')
    .select('id, slug, icp_targets, export_policy')
    .eq('id', clientId)
    .maybeSingle<ClientRow>();
  if (!data) return null;
  return toContext(data);
}

/** Look up scoring context by client.slug — what most ingest routes have on hand. */
export async function loadClientScoringContextBySlug(
  supabase: SupabaseClient,
  slug: string
): Promise<ClientScoringContext | null> {
  const { data } = await supabase
    .from('clients')
    .select('id, slug, icp_targets, export_policy')
    .eq('slug', slug)
    .maybeSingle<ClientRow>();
  if (!data) return null;
  return toContext(data);
}

function toContext(row: ClientRow): ClientScoringContext {
  return {
    clientId: row.id,
    clientSlug: row.slug ?? undefined,
    icpTargets: Array.isArray(row.icp_targets) ? row.icp_targets.filter(Boolean) : [],
    exportPolicy: (row.export_policy ?? null) as ExportPolicy | null,
  };
}
