// Shared helper that maps a ScrubbedLead (pipeline output) to the exact
// column shape the `leads` table expects. Keeps API routes thin and makes
// sure every ingestion path persists the quality-first fields identically.

import type { ScrubbedLead } from './pipeline';

export interface LeadRow {
  client_id: string;
  source_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone_e164?: string | null;
  company?: string | null;
  title?: string | null;
  linkedin_url?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  icp_segment?: string | null;
  tags: string[];
  rating?: number | null;
  rating_count?: number | null;
  website?: string | null;

  is_scrubbed: boolean;
  syntax_valid: boolean;
  mx_valid: boolean;
  smtp_valid: boolean;
  is_disposable: boolean;
  is_duplicate: boolean;
  is_suppressed: boolean;
  scrub_score: number;
  reject_reason: string | null;

  // Quality-first columns (migration 0005)
  quality_score: number;
  quality_reasons: string[];
  review_state: string;
  export_eligible: boolean;
  source_tier: string;
  source_confidence: number;
  verified_at: string | null;

  raw: unknown;
  scrubbed_at: string;
}

export function scrubbedToLeadRow(
  s: ScrubbedLead,
  ctx: { clientId: string; sourceId?: string | null }
): LeadRow {
  return {
    client_id: ctx.clientId,
    source_id: ctx.sourceId ?? null,
    first_name: (s.first_name as string | undefined) ?? null,
    last_name: (s.last_name as string | undefined) ?? null,
    email: s.normalized_email || null,
    phone_e164: s.phone_e164,
    company: (s.company as string | undefined) ?? null,
    title: (s.title as string | undefined) ?? null,
    linkedin_url: (s as { linkedin_url?: string }).linkedin_url ?? null,
    city: (s.city as string | undefined) ?? null,
    region: (s.region as string | undefined) ?? null,
    country: (s.country as string | undefined) ?? null,
    icp_segment: (s.icp_segment as string | undefined) ?? null,
    tags: s.tags ?? [],
    rating: (s.rating as number | undefined) ?? null,
    rating_count: (s.rating_count as number | undefined) ?? null,
    website: (s as { website?: string; source_url?: string }).website
      ?? (s as { source_url?: string }).source_url
      ?? null,
    is_scrubbed: s.is_scrubbed,
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    is_disposable: s.is_disposable,
    is_duplicate: s.is_duplicate,
    is_suppressed: s.is_suppressed,
    scrub_score: s.scrub_score,
    reject_reason: s.reject_reason ?? null,
    quality_score: s.quality_score,
    quality_reasons: s.quality_reasons,
    review_state: s.review_state,
    export_eligible: s.export_eligible,
    source_tier: s.source_tier,
    source_confidence: s.source_confidence,
    verified_at: s.verified_at,
    raw: s,
    scrubbed_at: new Date().toISOString(),
  };
}
