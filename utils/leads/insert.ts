/**
 * Shared helper for turning a ScrubbedLead into a fully-scored,
 * quality-gated lead row ready to insert into public.leads.
 *
 * Every ingest path goes through this so we have exactly one place where
 * the "what does the DB row look like" decision lives.
 */
import type { ScrubbedLead } from '@/utils/scrub/pipeline';
import {
  fromScrubbed,
  scoreLead,
  toLeadColumns,
  type SourceKind,
} from '@/utils/scoring/quality';

export interface BuildLeadRowArgs {
  client_id: string;
  source_id?: string | null;
  /** Logical source kind so the scoring engine picks the right tier. */
  source_kind?: SourceKind;
  /** True when the batch comes from a first-party CRM/ESP. */
  first_party?: boolean;
  /** Optional per-row override for last_verified_at. */
  last_verified_at?: Date;
}

/**
 * Build the full insert payload for one scrubbed lead.
 *
 * Returns every column the ingest routes were setting by hand, plus the
 * quality-first fields (quality_score, verification_status, source_tier,
 * export_eligibility, reason_codes, last_verified_at).
 */
export function buildLeadRow(s: ScrubbedLead, args: BuildLeadRowArgs) {
  const verdict = scoreLead(
    fromScrubbed(s, {
      source_kind: args.source_kind,
      first_party: args.first_party,
      last_verified_at: args.last_verified_at,
    })
  );
  const at = args.last_verified_at ?? new Date();

  return {
    client_id: args.client_id,
    source_id: args.source_id ?? null,

    first_name: s.first_name ?? null,
    last_name: s.last_name ?? null,
    email: s.normalized_email || null,
    phone_e164: s.phone_e164,

    company: s.company ?? null,
    title: s.title ?? null,
    linkedin_url: (s as { linkedin_url?: string }).linkedin_url ?? null,
    instagram_handle: (s as { instagram?: string }).instagram ?? null,
    city: s.city ?? null,
    region: s.region ?? null,
    country: s.country ?? null,

    icp_segment: s.icp_segment ?? null,
    tags: s.tags ?? [],

    // Scrub-stage flags (kept for backwards compat + dashboards).
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    is_disposable: s.is_disposable,
    is_duplicate: s.is_duplicate,
    is_suppressed: s.is_suppressed,
    scrub_score: s.scrub_score,
    reject_reason: s.reject_reason ?? null,

    raw: s,
    scrubbed_at: at.toISOString(),

    // Quality-first columns. Everything that enforces export gating.
    ...toLeadColumns(verdict, at),
  };
}
