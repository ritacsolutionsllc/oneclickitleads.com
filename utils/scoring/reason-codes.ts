// Reason codes: stable, machine-readable explanations for a lead's score.
//
// The UI joins on these codes to render badges; exports include them for
// audit. They are append-only — never rename or repurpose a code; deprecate
// and add a new one instead.

import type { ScoreInput, ScoreOutput } from './score';

export type ReasonCode =
  // Identity / verification
  | 'EMAIL_INVALID'
  | 'EMAIL_DISPOSABLE'
  | 'EMAIL_NO_MX'
  | 'EMAIL_SMTP_FAIL'
  | 'EMAIL_MISSING'
  | 'NO_PHONE'
  | 'NO_NAME'
  // Dedupe / suppression
  | 'DUPLICATE'
  | 'SUPPRESSED'
  // Completeness
  | 'NO_TITLE'
  | 'NO_COMPANY'
  | 'NO_LOCATION'
  | 'NO_SOCIAL'
  // ICP fit
  | 'OUT_OF_ICP'
  | 'NO_ICP_SEGMENT'
  // Freshness
  | 'STALE_VERIFICATION'
  // Source
  | 'LOW_SOURCE_TRUST'
  | 'PUBLIC_SCRAPED_ONLY'
  // Intent / firmographics
  | 'INTENT_LOW';

export interface ReasonCodeInput extends ScoreInput {
  /** Whether the email passed every scrub stage (syntax + mx + smtp + not disposable). */
  email_clean?: boolean;
}

export function reasonCodesFor(input: ReasonCodeInput, scores: ScoreOutput): ReasonCode[] {
  const codes: ReasonCode[] = [];

  // Identity / email verification
  if (!input.email) {
    codes.push('EMAIL_MISSING');
  } else {
    if (input.syntax_valid === false) codes.push('EMAIL_INVALID');
    if (input.is_disposable === true) codes.push('EMAIL_DISPOSABLE');
    if (input.mx_valid === false) codes.push('EMAIL_NO_MX');
    if (input.smtp_valid === false && input.mx_valid !== false) codes.push('EMAIL_SMTP_FAIL');
  }
  if (!input.phone_e164) codes.push('NO_PHONE');
  if (!input.first_name && !input.last_name) codes.push('NO_NAME');

  // Suppression / dedupe
  if (input.is_duplicate) codes.push('DUPLICATE');
  if (input.is_suppressed) codes.push('SUPPRESSED');

  // Completeness
  if (!input.title) codes.push('NO_TITLE');
  if (!input.company) codes.push('NO_COMPANY');
  if (!input.city && !input.region && !input.country) codes.push('NO_LOCATION');
  if (!input.linkedin_url && !input.instagram_handle) codes.push('NO_SOCIAL');

  // ICP fit
  const targets = (input.client_icp_targets ?? []).filter(Boolean);
  if (!input.icp_segment) {
    codes.push('NO_ICP_SEGMENT');
  } else if (targets.length > 0 && !targets.includes(input.icp_segment)) {
    codes.push('OUT_OF_ICP');
  }

  // Freshness
  if (input.verified_at) {
    const t =
      input.verified_at instanceof Date
        ? input.verified_at.getTime()
        : new Date(input.verified_at).getTime();
    if (Number.isFinite(t)) {
      const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24);
      if (ageDays > 90) codes.push('STALE_VERIFICATION');
    }
  }

  // Source
  const tier = input.source_trust_tier;
  if (tier != null) {
    if (tier >= 5) codes.push('LOW_SOURCE_TRUST');
    else if (tier === 4) codes.push('PUBLIC_SCRAPED_ONLY');
  }

  // Intent (proxy)
  if (scores.intent_score < 0.45) codes.push('INTENT_LOW');

  return dedupe(codes);
}

function dedupe(codes: ReasonCode[]): ReasonCode[] {
  return Array.from(new Set(codes));
}
