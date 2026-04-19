-- Quality-first lead platform schema
--
-- Every lead must carry an explainable quality score, a review state,
-- source lineage, and an explicit export eligibility flag before it can
-- reach a client. Scraped or unverified records default to the review
-- queue instead of silently dropping.
--
-- This migration is additive: existing rows remain readable. A backfill
-- at the bottom populates sensible defaults for rows ingested pre-quality.

-- =========================================================
-- sources: tier + confidence for lineage
-- =========================================================
alter table public.sources
  add column if not exists tier       text,          -- tier_1_verified | tier_2_enriched | tier_3_public | tier_4_scraped
  add column if not exists confidence int;           -- 0-100

-- =========================================================
-- leads: quality, review state, export eligibility, lineage
-- =========================================================
alter table public.leads
  add column if not exists quality_score   int,                         -- 0-100, canonical engine output
  add column if not exists quality_reasons text[] not null default '{}', -- reason codes from the scoring engine
  add column if not exists review_state    text not null default 'pending', -- pending | approved | review | quarantined | discarded
  add column if not exists export_eligible boolean not null default false,
  add column if not exists source_tier     text,                         -- denormalized copy of sources.tier for fast queries
  add column if not exists source_confidence int,
  add column if not exists verified_at     timestamptz,                  -- last successful verification (smtp, first-party, manual)
  add column if not exists operator_decision text;                       -- 'approved' | 'discarded' | 'needs_reverify' | null

-- Constraint: review_state must be one of the known states.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_review_state_check'
  ) then
    alter table public.leads
      add constraint leads_review_state_check
      check (review_state in ('pending','approved','review','quarantined','discarded'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_source_tier_check'
  ) then
    alter table public.leads
      add constraint leads_source_tier_check
      check (
        source_tier is null
        or source_tier in ('tier_1_verified','tier_2_enriched','tier_3_public','tier_4_scraped')
      );
  end if;
end $$;

-- =========================================================
-- Indexes for export gating + review queue
-- =========================================================
create index if not exists idx_leads_export_eligible
  on public.leads (client_id, export_eligible, quality_score desc)
  where export_eligible = true;

create index if not exists idx_leads_review_state
  on public.leads (client_id, review_state);

create index if not exists idx_leads_quality_score
  on public.leads (client_id, quality_score desc nulls last);

-- =========================================================
-- v_client_usage: count export-eligible leads for plan caps
-- =========================================================
drop view if exists public.v_client_usage;
create or replace view public.v_client_usage as
select
  c.id as client_id,
  c.plan,
  c.stripe_customer_id,
  c.plan_current_period_end,
  count(l.id) filter (where l.created_at >= date_trunc('month', now())) as leads_this_month,
  count(l.id) filter (where l.export_eligible and l.created_at >= date_trunc('month', now())) as clean_this_month,
  count(l.id) filter (where l.review_state = 'review' and l.created_at >= date_trunc('month', now())) as in_review_this_month,
  count(l.id) filter (where l.review_state = 'quarantined' and l.created_at >= date_trunc('month', now())) as quarantined_this_month,
  count(distinct l.icp_segment) filter (where l.created_at >= date_trunc('month', now())) as segments_used_this_month,
  case c.plan
    when 'starter'    then 2500
    when 'growth'     then 15000
    when 'agency'     then 60000
    when 'enterprise' then 1000000
    else 100
  end as monthly_cap
from public.clients c
left join public.leads l on l.client_id = c.id
group by c.id;

-- =========================================================
-- Backfill existing rows
-- =========================================================
-- Rows that already passed the legacy scrub get approved + export-eligible so
-- current dashboards don't go dark. Everything else lands in review.
update public.leads
set
  review_state    = case
    when is_suppressed then 'quarantined'
    when is_duplicate  then 'quarantined'
    when is_disposable then 'quarantined'
    when is_scrubbed   then 'approved'
    else 'review'
  end,
  export_eligible = coalesce(is_scrubbed, false)
    and not coalesce(is_suppressed, false)
    and not coalesce(is_duplicate, false)
    and not coalesce(is_disposable, false),
  quality_score   = coalesce(scrub_score, 0),
  verified_at     = case when smtp_valid then coalesce(scrubbed_at, created_at) else null end
where review_state = 'pending';
