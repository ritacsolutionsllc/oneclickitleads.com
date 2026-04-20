/**
 * Canonical export eligibility query builder.
 *
 * Every path that hands leads to a client (CSV, smartly.io push, Meta CAPI,
 * future destinations) MUST go through `applyExportGate`. The policy is
 * intentionally defined once here and in Postgres (0005_quality_first.sql's
 * generated `export_eligible` column) so the same rules apply whether you
 * query through RLS, the service role, or a SQL audit.
 *
 * Policy (must match the generated column):
 *   - is_scrubbed = true
 *   - not a duplicate, not suppressed, not disposable
 *   - has email OR phone_e164
 *   - quality_score >= 60
 *   - lead_status in ('approved','exported')
 */

export const EXPORT_MIN_QUALITY_SCORE = 60;

// Minimal structural type: anything that supports the two filter methods we
// chain here. Keeps this helper decoupled from Supabase's internal generics
// which change across versions of @supabase/postgrest-js.
interface GatedBuilder<Self> {
  eq(column: string, value: unknown): Self;
  in(column: string, values: readonly unknown[]): Self;
}

/**
 * Apply the export gate to a Supabase query builder. Returns the filtered
 * builder so callers can chain additional filters (segment, min_score override,
 * limit, order).
 */
export function applyExportGate<T extends GatedBuilder<T>>(q: T): T {
  // export_eligible is a DB-enforced generated column; filtering on it lets
  // Postgres use the partial index idx_leads_export_eligible. We still pin
  // lead_status explicitly so quarantined-but-eligible records stay locked.
  return q.eq('export_eligible', true).in('lead_status', ['approved', 'exported']);
}

/**
 * Describe the export policy in a single string — handy for /api error bodies
 * and dashboard tooltips so clients understand why a lead didn't export.
 */
export const EXPORT_POLICY_SUMMARY =
  `Leads must be verified (MX-valid or better), non-duplicate, non-suppressed, ` +
  `have at least one contact method, score ≥ ${EXPORT_MIN_QUALITY_SCORE}, and ` +
  `be approved by the scoring engine. Rejected records stay in the review queue.`;
