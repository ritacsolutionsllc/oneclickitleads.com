// The full scrubbing pipeline. Composes email check + phone + enrichment + dedupe + suppression,
// then runs the canonical scoring engine so every row exits with a quality_score,
// verification_status, source_tier, export_eligibility and reason_codes.
//
// Usage (from an API route or edge function):
//   const clean = await scrubBatch(supabase, clientId, rawRows, { sourceKind: 'scraped' });

import { scrubEmail, normalizeEmail } from './email';
import { normalizePhone } from './phone';
import { enrich } from './enrich';
import { scoreLead, type ScoreResult, type SourceTier } from '../scoring/score';
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
  score: ScoreResult;
}

export interface ScrubOptions {
  doEnrich?: boolean;
  /** Raw source kind (sources.kind) — used to derive source_tier. */
  sourceKind?: string | null;
  /** Explicit override for source_tier when the caller knows better. */
  sourceTier?: SourceTier;
  /** When this batch was verified; defaults to now. Used for freshness. */
  verifiedAt?: Date;
}

export async function scrubBatch(
  supabase: SupabaseClient,
  clientId: string,
  rows: RawLead[],
  opts: ScrubOptions = { doEnrich: true }
): Promise<ScrubbedLead[]> {
  const verifiedAt = opts.verifiedAt ?? new Date();

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

    let enrichedFields: Partial<RawLead> = {};
    if (
      opts.doEnrich &&
      emailResult?.syntax_valid &&
      emailResult?.mx_valid &&
      !isSuppressed &&
      !isDuplicate
    ) {
      enrichedFields = (await enrich(normalized)) as Partial<RawLead>;
    }

    // Merge scrubbed row + enrichment, then score it. Enrichment can fill in
    // first_name/title/company — score has to see the post-enrichment shape.
    const merged = {
      ...row,
      ...enrichedFields,
      email: normalized || undefined,
      phone_e164: phoneE164,
    };

    const isScrubbed =
      !!emailResult?.syntax_valid &&
      !!emailResult?.mx_valid &&
      !emailResult?.is_disposable &&
      !isDuplicate &&
      !isSuppressed;

    const score = scoreLead({
      email: merged.email ?? null,
      phone_e164: merged.phone_e164 ?? null,
      first_name: (merged.first_name as string | undefined) ?? null,
      last_name: (merged.last_name as string | undefined) ?? null,
      company: (merged.company as string | undefined) ?? null,
      title: (merged.title as string | undefined) ?? null,
      icp_segment: merged.icp_segment ?? null,
      city: merged.city ?? null,
      region: merged.region ?? null,
      country: merged.country ?? null,
      tags: merged.tags ?? null,
      syntax_valid: emailResult?.syntax_valid ?? null,
      mx_valid: emailResult?.mx_valid ?? null,
      smtp_valid: emailResult?.smtp_valid ?? null,
      is_disposable: emailResult?.is_disposable ?? false,
      is_duplicate: isDuplicate,
      is_suppressed: !!isSuppressed,
      source_kind: opts.sourceKind ?? null,
      source_tier: opts.sourceTier ?? null,
      rating: (merged.rating as number | undefined) ?? null,
      rating_count: (merged.rating_count as number | undefined) ?? null,
      verified_at: verifiedAt,
    });

    results.push({
      ...row,
      ...enrichedFields,
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
      score,
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
