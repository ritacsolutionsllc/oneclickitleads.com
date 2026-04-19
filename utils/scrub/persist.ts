/**
 * Canonical `leads` insert shape. Every ingestion route funnels scrubbed
 * rows through this so the DB always sees the same quality-first columns
 * (quality_score, quality_tier, verification_status, source_tier,
 * export_eligible, reason_codes, review_state, verified_at).
 *
 * Keeps route handlers thin — they only decide the source + extra tags,
 * everything else rides the scoring engine's verdict.
 */

import type { ScrubbedLead } from './pipeline';

export interface LeadInsertExtras {
  client_id: string;
  source_id?: string | null;
}

export function toLeadRow(s: ScrubbedLead, extras: LeadInsertExtras) {
  return {
    client_id: extras.client_id,
    source_id: extras.source_id ?? null,

    // identity
    first_name: s.first_name ?? null,
    last_name: s.last_name ?? null,
    email: s.normalized_email || null,
    phone_e164: s.phone_e164,
    company: s.company ?? null,
    title: s.title ?? null,
    linkedin_url: (s as { linkedin_url?: string }).linkedin_url ?? null,
    instagram_handle: (s as { instagram_handle?: string }).instagram_handle ?? null,
    city: s.city ?? null,
    region: s.region ?? null,
    country: s.country ?? null,

    // ICP
    icp_segment: s.icp_segment ?? null,
    tags: s.tags ?? [],

    // Google Places signals (carried through when set)
    rating: (s as { rating?: number }).rating ?? null,
    rating_count: (s as { rating_count?: number }).rating_count ?? null,
    website:
      (s as { website?: string }).website ??
      (s as { source_url?: string }).source_url ??
      null,

    // legacy scrub flags (kept for BC)
    is_scrubbed: s.is_scrubbed,
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    is_disposable: s.is_disposable,
    is_duplicate: s.is_duplicate,
    is_suppressed: s.is_suppressed,
    scrub_score: s.scrub_score,
    reject_reason: s.reject_reason ?? null,

    // quality-first columns
    quality_score: s.quality_score,
    quality_tier: s.quality_tier,
    verification_status: s.verification_status,
    source_tier: s.source_tier,
    export_eligible: s.export_eligible,
    reason_codes: s.reason_codes,
    review_state: s.review_state,
    verified_at: s.verified_at,

    raw: s,
    scrubbed_at: new Date().toISOString(),
  };
}
