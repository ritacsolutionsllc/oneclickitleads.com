-- Quality-first lead model.
--
-- Goal: nothing leaves the platform without an explainable score,
-- a verification status, a source lineage, and an explicit export
-- eligibility decision.
--
-- These columns are written by utils/quality/score.ts and read by
-- the export and review-queue routes. The scoring engine is the
-- single source of truth — DB-side defaults are deliberately the
-- safest possible value (quarantined / unverified) so unscored rows
-- can never accidentally exit through the export gate.

-- =========================================================
-- sources: tag every batch with its confidence tier
-- =========================================================
alter table public.sources
  add column if not exists tier text
    check (tier in ('first_party','verified_directory','enriched','scraped','purchased','unknown'))
    default 'unknown';

create index if not exists idx_sources_tier
  on public.sources (client_id, tier);

-- =========================================================
-- leads: quality + eligibility + lineage
-- =========================================================
alter table public.leads
  -- canonical 0-100 quality score, deterministic, computed by
  -- utils/quality/score.ts. Distinct from the Google-Places-specific
  -- lead_quality_score generated column from migration 0003.
  add column if not exists quality_score int
    check (quality_score is null or (quality_score between 0 and 100)),

  -- where this lead sits in the verification ladder
  add column if not exists verification_status text
    check (verification_status in (
      'unverified','syntax_only','mx_valid','smtp_verified','first_party'
    ))
    default 'unverified',

  -- which tier of source produced the lead
  add column if not exists source_tier text
    check (source_tier in (
      'first_party','verified_directory','enriched','scraped','purchased','unknown'
    ))
    default 'unknown',

  -- final gate the export/push routes check before releasing a lead
  add column if not exists export_eligibility text
    check (export_eligibility in ('eligible','review','quarantined','rejected'))
    default 'quarantined',

  -- machine-readable explanations for the operator dashboard
  add column if not exists reason_codes text[]
    not null default '{}',

  -- where the lead lives in the human review workflow
  add column if not exists review_state text
    check (review_state in ('new','in_review','approved','discarded','reverify'))
    default 'new',

  -- last time we (re)verified or refreshed the record
  add column if not exists verified_at timestamptz,

  -- last time the scoring engine ran against this row
  add column if not exists quality_computed_at timestamptz;

-- The hot-path queries the export/review routes will hit.
create index if not exists idx_leads_eligibility
  on public.leads (client_id, export_eligibility, quality_score desc);

create index if not exists idx_leads_review_state
  on public.leads (client_id, review_state)
  where review_state in ('new','in_review','reverify');

create index if not exists idx_leads_verified_at
  on public.leads (client_id, verified_at desc nulls last);

-- =========================================================
-- v_client_usage: surface eligible-export count, not just scrubbed
-- =========================================================
drop view if exists public.v_client_usage;
create or replace view public.v_client_usage as
select
  c.id                      as client_id,
  c.plan,
  c.stripe_customer_id,
  c.plan_current_period_end,
  count(l.id) filter (where l.created_at >= date_trunc('month', now()))
    as leads_this_month,
  count(l.id) filter (where l.is_scrubbed and l.created_at >= date_trunc('month', now()))
    as clean_this_month,
  count(l.id) filter (
    where l.export_eligibility = 'eligible'
      and l.created_at >= date_trunc('month', now())
  ) as eligible_this_month,
  count(l.id) filter (
    where l.export_eligibility in ('review','quarantined')
      and l.created_at >= date_trunc('month', now())
  ) as in_review_this_month,
  count(distinct l.icp_segment) filter (where l.created_at >= date_trunc('month', now()))
    as segments_used_this_month,
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
-- v_lead_quality_breakdown: per-client quality dashboard feed
-- =========================================================
create or replace view public.v_lead_quality_breakdown as
select
  client_id,
  export_eligibility,
  source_tier,
  count(*) as lead_count,
  avg(coalesce(quality_score, 0))::int as avg_quality_score,
  min(coalesce(quality_score, 0))      as min_quality_score,
  max(coalesce(quality_score, 0))      as max_quality_score
from public.leads
group by client_id, export_eligibility, source_tier;
