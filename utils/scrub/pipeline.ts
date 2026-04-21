// The full scrubbing pipeline. Composes email check + phone + enrichment + dedupe + suppression.
//
// Usage (from an API route or edge function):
//   const clean = await scrubBatch(supabase, clientId, rawRows);

import { scrubEmail, normalizeEmail } from './email';
import { normalizePhone } from './phone';
import { enrich } from './enrich';
import { scoreLead, type ScoreOutput } from '../scoring/score';
import { assignTier, type ExportPolicy, type ExportTier } from '../scoring/tier';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RawLead {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  city?: string;
  region?: string;
  country?: string;
  icp_segment?: string;
  source_url?: string;
  tags?: string[];
  [k: string]: unknown;
}

export interface ScrubbedLead extends RawLead, ScoreOutput {
  normalized_email: string;
  phone_e164: string | null;
  syntax_valid: boolean;
  mx_valid: boolean;
  smtp_valid: boolean;
  is_disposable: boolean;
  is_duplicate: boolean;
  is_suppressed: boolean;
  scrub_score: number;
  reject_reason?: string;
  is_scrubbed: boolean;
  export_tier: ExportTier;
  verified_at: string;
  verified_by: string;
}

export interface ScrubOptions {
  doEnrich?: boolean;
  /** Source trust tier [1..5] for every row in this batch. Defaults to 4 (public-scraped). */
  sourceTrustTier?: number;
  /** Client's target ICP segments, used by the ICP fit sub-score. */
  clientIcpTargets?: string[];
  /** Per-client export_policy, used to apply min_composite_score. */
  exportPolicy?: ExportPolicy | null;
}

export async function scrubBatch(
  supabase: SupabaseClient,
  clientId: string,
  rows: RawLead[],
  opts: ScrubOptions = { doEnrich: true }
): Promise<ScrubbedLead[]> {
  const sourceTrustTier = opts.sourceTrustTier ?? 4;

  // 1. pull suppressions once
  const { data: sup } = await supabase
    .from('suppressions')
    .select('email, phone')
    .eq('client_id', clientId);
  const supEmails = new Set((sup ?? []).map((s: { email: string | null }) => s.email?.toLowerCase()).filter(Boolean));
  const supPhones = new Set((sup ?? []).map((s: { phone: string | null }) => s.phone).filter(Boolean));

  // 2. pull existing email hashes + phone numbers for dedupe
  const { data: existing } = await supabase
    .from('leads')
    .select('email_hash, phone_e164')
    .eq('client_id', clientId);
  const existingHashes = new Set(
    (existing ?? [])
      .map((r: { email_hash: string | null }) => r.email_hash)
      .filter((h): h is string => !!h)
  );
  const existingPhones = new Set(
    (existing ?? [])
      .map((r: { phone_e164: string | null }) => r.phone_e164)
      .filter((p): p is string => !!p)
  );

  // 3. process each row
  const results: ScrubbedLead[] = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();

  for (const row of rows) {
    const emailRaw = row.email ?? '';
    const emailResult = emailRaw ? await scrubEmail(emailRaw) : null;
    const normalized = emailResult?.normalized ?? normalizeEmail(emailRaw);
    const phoneE164 = row.phone ? normalizePhone(row.phone) : null;

    const isSuppressed =
      (normalized && supEmails.has(normalized)) ||
      (phoneE164 && supPhones.has(phoneE164)) ||
      false;

    // Dedupe on email hash OR phone (E.164). A row with a phone-only match
    // against an existing phone-only lead is still a dup.
    const hash = normalized ? await sha256(normalized) : '';
    const emailDup = !!hash && (existingHashes.has(hash) || seenEmails.has(hash));
    const phoneDup = !!phoneE164 && (existingPhones.has(phoneE164) || seenPhones.has(phoneE164));
    const isDuplicate = emailDup || phoneDup;
    if (hash) seenEmails.add(hash);
    if (phoneE164) seenPhones.add(phoneE164);

    let enrichedFields = {};
    if (
      opts.doEnrich &&
      emailResult?.syntax_valid &&
      emailResult?.mx_valid &&
      !isSuppressed &&
      !isDuplicate
    ) {
      enrichedFields = await enrich(normalized);
    }

    const isScrubbed =
      !!emailResult?.syntax_valid &&
      !!emailResult?.mx_valid &&
      !emailResult?.is_disposable &&
      !isDuplicate &&
      !isSuppressed;

    // Merge the raw row with enrichment so scoring sees the full picture.
    const merged = { ...row, ...enrichedFields } as RawLead;
    const scores = scoreLead({
      syntax_valid: !!emailResult?.syntax_valid,
      mx_valid: !!emailResult?.mx_valid,
      smtp_valid: !!emailResult?.smtp_valid,
      is_disposable: !!emailResult?.is_disposable,
      is_duplicate: isDuplicate,
      is_suppressed: !!isSuppressed,
      email: normalized,
      phone_e164: phoneE164,
      first_name: merged.first_name ?? null,
      last_name: merged.last_name ?? null,
      company: merged.company ?? null,
      title: merged.title ?? null,
      city: merged.city ?? null,
      region: merged.region ?? null,
      country: merged.country ?? null,
      linkedin_url: (merged as { linkedin_url?: string | null }).linkedin_url ?? null,
      instagram_handle: (merged as { instagram_handle?: string | null }).instagram_handle ?? null,
      icp_segment: merged.icp_segment ?? null,
      client_icp_targets: opts.clientIcpTargets ?? null,
      verified_at: null, // scrubbed right now
      source_trust_tier: sourceTrustTier,
    });

    const export_tier = assignTier({
      composite_score: scores.composite_score,
      is_suppressed: !!isSuppressed,
      is_duplicate: isDuplicate,
      is_scrubbed: isScrubbed,
      policy: opts.exportPolicy ?? null,
    });

    results.push({
      ...merged,
      normalized_email: normalized,
      phone_e164: phoneE164,
      syntax_valid: !!emailResult?.syntax_valid,
      mx_valid: !!emailResult?.mx_valid,
      smtp_valid: !!emailResult?.smtp_valid,
      is_disposable: !!emailResult?.is_disposable,
      is_duplicate: isDuplicate,
      is_suppressed: !!isSuppressed,
      scrub_score: emailResult?.score ?? 0,
      reject_reason:
        emailResult?.reject_reason ??
        (isDuplicate ? 'duplicate' : isSuppressed ? 'suppressed' : undefined),
      is_scrubbed: isScrubbed,
      ...scores,
      export_tier,
      verified_at: new Date().toISOString(),
      verified_by: 'scrub-pipeline',
    });
  }

  return results;
}

/**
 * Score/tier fields to merge into a `leads` insert payload. composite_score
 * is intentionally omitted — it's a stored generated column in the DB and
 * rejects explicit inserts.
 */
export function scoringInsertFields(s: ScrubbedLead) {
  return {
    identity_score: s.identity_score,
    icp_fit_score: s.icp_fit_score,
    completeness_score: s.completeness_score,
    freshness_score: s.freshness_score,
    intent_score: s.intent_score,
    source_confidence: s.source_confidence,
    export_tier: s.export_tier,
    verified_at: s.verified_at,
    verified_by: s.verified_by,
    reason_codes: s.reason_codes,
    last_rescored_at: s.verified_at,
  };
}

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
