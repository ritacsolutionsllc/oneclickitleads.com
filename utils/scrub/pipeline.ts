// The full scrubbing + scoring pipeline. Composes email check + phone +
// enrichment + dedupe + suppression, then hands every row to the quality
// scoring engine so downstream routes get a single verdict per lead.
//
// Usage (from an API route or edge function):
//   const clean = await scrubBatch(supabase, clientId, rawRows, { source_kind: 'apollo' });

import { scrubEmail, normalizeEmail } from './email';
import { normalizePhone } from './phone';
import { enrich, type EnrichedLead } from './enrich';
import { scoreLead, type ScoringResult } from '../scoring/score';
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

export interface ScrubbedLead extends RawLead, ScoringResult {
  normalized_email: string;
  phone_e164: string | null;
  syntax_valid: boolean;
  mx_valid: boolean;
  smtp_valid: boolean;
  is_disposable: boolean;
  is_duplicate: boolean;
  is_suppressed: boolean;
  scrub_score: number;            // legacy: email-only 0-100 score
  reject_reason?: string;
  is_scrubbed: boolean;
  verified_at: string | null;
}

export interface ScrubOptions {
  doEnrich?: boolean;
  /** e.g. 'apollo' | 'commonroom' | 'places' | 'osm' | 'scraped' | 'firstparty' */
  source_kind?: string;
}

export async function scrubBatch(
  supabase: SupabaseClient,
  clientId: string,
  rows: RawLead[],
  opts: ScrubOptions = {}
): Promise<ScrubbedLead[]> {
  const { doEnrich = true, source_kind } = opts;
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

    let enrichedFields: EnrichedLead = {};
    if (
      doEnrich &&
      emailResult?.syntax_valid &&
      emailResult?.mx_valid &&
      !isSuppressed &&
      !isDuplicate
    ) {
      enrichedFields = await enrich(normalized);
    }

    const syntaxValid = !!emailResult?.syntax_valid;
    const mxValid = !!emailResult?.mx_valid;
    const smtpValid = !!emailResult?.smtp_valid;
    const isDisposable = !!emailResult?.is_disposable;

    // Old per-email "scrub_score" kept for backwards compatibility + the
    // legacy v_client_usage count. The new unified score lives in
    // quality_score and is produced below.
    const legacyScrubScore = emailResult?.score ?? (phoneE164 ? 40 : 0);
    const rejectReason =
      emailResult?.reject_reason ??
      (isDuplicate ? 'duplicate' : isSuppressed ? 'suppressed' : undefined);

    const isScrubbed =
      (syntaxValid && mxValid && !isDisposable && !isDuplicate && !isSuppressed) ||
      // Phone-only leads from high-trust directory sources (Places/OSM) are
      // still considered "scrubbed" — the scoring engine decides export.
      (!emailRaw && !!phoneE164 && !isDuplicate && !isSuppressed);

    const merged: RawLead = { ...row, ...enrichedFields };
    const scored = scoreLead({
      syntax_valid: syntaxValid,
      mx_valid: mxValid,
      smtp_valid: smtpValid,
      is_disposable: isDisposable,
      is_duplicate: isDuplicate,
      is_suppressed: isSuppressed,
      reject_reason: rejectReason,
      email: normalized || null,
      phone_e164: phoneE164,
      first_name: merged.first_name,
      last_name: merged.last_name,
      company: merged.company,
      title: merged.title,
      city: merged.city,
      region: merged.region,
      country: merged.country,
      icp_segment: merged.icp_segment,
      tags: merged.tags,
      rating: merged.rating,
      rating_count: merged.rating_count,
      source_kind,
    });

    results.push({
      ...merged,
      normalized_email: normalized,
      phone_e164: phoneE164,
      syntax_valid: syntaxValid,
      mx_valid: mxValid,
      smtp_valid: smtpValid,
      is_disposable: isDisposable,
      is_duplicate: isDuplicate,
      is_suppressed: !!isSuppressed,
      scrub_score: legacyScrubScore,
      reject_reason: rejectReason,
      is_scrubbed: isScrubbed,
      verified_at: smtpValid ? new Date().toISOString() : null,
      ...scored,
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
