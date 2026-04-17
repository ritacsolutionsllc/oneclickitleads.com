// The full scrubbing pipeline. Composes email check + phone + enrichment + dedupe + suppression.
//
// Usage (from an API route or edge function):
//   const clean = await scrubBatch(supabase, clientId, rawRows);

import { scrubEmail, normalizeEmail } from './email';
import { normalizePhone } from './phone';
import { enrich } from './enrich';
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
}

export async function scrubBatch(
  supabase: SupabaseClient,
  clientId: string,
  rows: RawLead[],
  opts: { doEnrich?: boolean } = { doEnrich: true }
): Promise<ScrubbedLead[]> {
  // 1. pull suppressions once
  const { data: sup } = await supabase
    .from('suppressions')
    .select('email, phone')
    .eq('client_id', clientId);
  const supEmails = new Set((sup ?? []).map((s: { email: string | null }) => s.email?.toLowerCase()).filter(Boolean));
  const supPhones = new Set((sup ?? []).map((s: { phone: string | null }) => s.phone).filter(Boolean));

  // 2. pull existing email hashes for dedupe
  const { data: existing } = await supabase
    .from('leads')
    .select('email_hash')
    .eq('client_id', clientId);
  const existingHashes = new Set((existing ?? []).map((r: { email_hash: string }) => r.email_hash));

  // 3. process each row
  const results: ScrubbedLead[] = [];
  const seenInBatch = new Set<string>();

  for (const row of rows) {
    const emailRaw = row.email ?? '';
    const emailResult = emailRaw ? await scrubEmail(emailRaw) : null;
    const normalized = emailResult?.normalized ?? normalizeEmail(emailRaw);
    const phoneE164 = row.phone ? normalizePhone(row.phone) : null;

    const isSuppressed =
      (normalized && supEmails.has(normalized)) ||
      (phoneE164 && supPhones.has(phoneE164)) ||
      false;

    // dedupe: hash of normalized email
    const hash = await sha256(normalized || '');
    const isDuplicate =
      (!!normalized && (existingHashes.has(hash) || seenInBatch.has(hash)));
    if (normalized) seenInBatch.add(hash);

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
