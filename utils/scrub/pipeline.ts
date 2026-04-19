// The full scrubbing pipeline. Composes email check + phone + enrichment + dedupe + suppression.
//
// Usage (from an API route or edge function):
//   const clean = await scrubBatch(supabase, clientId, rawRows);

import { scrubEmail, normalizeEmail } from './email';
import { normalizePhone } from './phone';
import { enrich } from './enrich';
import {
  scoreLead,
  type ReviewState,
  type SourceTier,
} from '@/utils/quality/score';
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
  rating?: number | null;
  rating_count?: number | null;
  [k: string]: unknown;
}

export interface ScrubbedLead extends RawLead {
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

  // Quality-first fields populated by the canonical scoring engine.
  quality_score: number;
  quality_reasons: string[];
  source_tier: SourceTier;
  source_confidence: number;
  review_state: ReviewState;
  export_eligible: boolean;
  verified_at: string | null;
}

export interface ScrubOptions {
  doEnrich?: boolean;
  /** Source tier for every row in this batch (e.g. 'tier_3_public' for places). */
  sourceTier?: SourceTier;
  /** Provider-reported confidence 0-100 (Hunter confidence, Apollo match, etc). */
  sourceConfidence?: number;
}

export async function scrubBatch(
  supabase: SupabaseClient,
  clientId: string,
  rows: RawLead[],
  opts: ScrubOptions = { doEnrich: true }
): Promise<ScrubbedLead[]> {
  const sourceTier: SourceTier = opts.sourceTier ?? 'tier_4_scraped';
  const sourceConfidence = opts.sourceConfidence ?? defaultConfidenceForTier(sourceTier);
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

    const merged: RawLead & Record<string, unknown> = {
      ...row,
      ...enrichedFields,
    };

    const quality = scoreLead({
      syntax_valid: !!emailResult?.syntax_valid,
      mx_valid: !!emailResult?.mx_valid,
      smtp_valid: !!emailResult?.smtp_valid,
      is_disposable: !!emailResult?.is_disposable,
      is_duplicate: isDuplicate,
      is_suppressed: !!isSuppressed,
      email: normalized || null,
      phone_e164: phoneE164,
      first_name: (merged.first_name as string | undefined) ?? null,
      last_name: (merged.last_name as string | undefined) ?? null,
      company: (merged.company as string | undefined) ?? null,
      title: (merged.title as string | undefined) ?? null,
      city: (merged.city as string | undefined) ?? null,
      region: (merged.region as string | undefined) ?? null,
      country: (merged.country as string | undefined) ?? null,
      icp_segment: (merged.icp_segment as string | undefined) ?? null,
      tags: (merged.tags as string[] | undefined) ?? null,
      source_tier: sourceTier,
      source_confidence: sourceConfidence,
      rating: (merged.rating as number | undefined) ?? null,
      rating_count: (merged.rating_count as number | undefined) ?? null,
      ingested_at: new Date(),
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
      quality_score: quality.score,
      quality_reasons: quality.reasons,
      source_tier: quality.source_tier,
      source_confidence: sourceConfidence,
      review_state: quality.review_state,
      export_eligible: quality.export_eligible,
      verified_at: quality.verified_at,
    });
  }

  return results;
}

function defaultConfidenceForTier(tier: SourceTier): number {
  switch (tier) {
    case 'tier_1_verified': return 95;
    case 'tier_2_enriched': return 75;
    case 'tier_3_public':   return 55;
    case 'tier_4_scraped':  return 30;
  }
}

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
