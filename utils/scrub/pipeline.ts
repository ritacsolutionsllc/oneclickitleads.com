// The full scrubbing pipeline. Composes email check + phone + enrichment + dedupe + suppression.
//
// Usage (from an API route or edge function):
//   const clean = await scrubBatch(supabase, clientId, rawRows);

import { scrubEmail, normalizeEmail } from './email';
import { normalizePhone } from './phone';
import { enrich } from './enrich';
import type { SupabaseClient } from '@supabase/supabase-js';
import { scoreLead } from '@/utils/scoring/score';
import type { ReviewState, SourceTier, VerificationStatus } from '@/utils/scoring/types';

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
  linkedin_url?: string;
  instagram_handle?: string;
  website?: string;
  rating?: number;
  rating_count?: number;
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
  quality_score: number;
  quality_reasons: string[];
  verification_status: VerificationStatus;
  source_tier: SourceTier;
  review_state: ReviewState;
  export_eligible: boolean;
}

export async function scrubBatch(
  supabase: SupabaseClient,
  clientId: string,
  rows: RawLead[],
  opts: { doEnrich?: boolean; sourceKind?: string } = { doEnrich: true }
): Promise<ScrubbedLead[]> {
  const sourceKind = opts.sourceKind;
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

    const merged = { ...row, ...enrichedFields };
    const rejectReason =
      emailResult?.reject_reason ??
      (isDuplicate ? 'duplicate' : isSuppressed ? 'suppressed' : undefined);

    const scored = scoreLead({
      email: normalized || null,
      phone_e164: phoneE164,
      first_name: (merged.first_name as string) ?? null,
      last_name: (merged.last_name as string) ?? null,
      company: (merged.company as string) ?? null,
      title: (merged.title as string) ?? null,
      linkedin_url: (merged.linkedin_url as string) ?? null,
      instagram_handle: (merged.instagram_handle as string) ?? null,
      website: (merged.website as string) ?? (merged.source_url as string) ?? null,
      city: (merged.city as string) ?? null,
      region: (merged.region as string) ?? null,
      country: (merged.country as string) ?? null,
      icp_segment: (merged.icp_segment as string) ?? null,
      tags: (merged.tags as string[] | undefined) ?? null,
      rating: (merged.rating as number | undefined) ?? null,
      rating_count: (merged.rating_count as number | undefined) ?? null,
      is_scrubbed: isScrubbed,
      is_duplicate: isDuplicate,
      is_suppressed: !!isSuppressed,
      is_disposable: !!emailResult?.is_disposable,
      syntax_valid: !!emailResult?.syntax_valid,
      mx_valid: !!emailResult?.mx_valid,
      smtp_valid: !!emailResult?.smtp_valid,
      reject_reason: rejectReason,
      source_kind: sourceKind,
      source_url: (merged.source_url as string) ?? null,
      ingested_at: new Date(),
      verified_at: emailResult?.mx_valid ? new Date() : null,
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
      reject_reason: rejectReason,
      is_scrubbed: isScrubbed,
      quality_score: scored.quality_score,
      quality_reasons: scored.quality_reasons,
      verification_status: scored.verification_status,
      source_tier: scored.source_tier,
      review_state: scored.review_state,
      export_eligible: scored.export_eligible,
    });
  }

  return results;
}

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
