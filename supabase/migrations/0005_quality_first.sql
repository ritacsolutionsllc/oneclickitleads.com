-- 0005 — Quality-first lead schema.
--
-- Turns OneClickitLeads from a "volume of clean rows" product into a
-- "verified, scored, explainable, export-gated" product. Every column added
-- here is queryable, deterministic, and computed by the scoring helper in
-- utils/scoring/score.ts. Ingest paths must now populate these fields;
-- export paths must filter on `export_eligible`.
--
-- Vocabulary (keep in sync with utils/scoring/score.ts):
--   verification_status: 'unverified' | 'mx_only' | 'smtp_verified' | 'manual_verified' | 'bounced'
--   source_tier:         'unknown' | 'firstparty' | 'verified_api' | 'public_directory' | 'scraped' | 'purchased'
--   review_state:        'ready' | 'review' | 'quarantined' | 'approved' | 'discarded'

alter table public.leads
  add column if not exists quality_score       integer,
  add column if not exists quality_reasons     text[] not null default '{}',
  add column if not exists verification_status text   not null default 'unverified',
  add column if not exists source_tier         text   not null default 'unknown',
  add column if not exists review_state        text   not null default 'review',
  add column if not exists verified_at         timestamptz,
  add column if not exists last_scored_at      timestamptz;

-- Keep the vocabulary honest so UI dashboards can trust the enum values.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_quality_score_chk') then
    alter table public.leads
      add constraint leads_quality_score_chk
      check (quality_score is null or (quality_score between 0 and 100));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_verification_status_chk') then
    alter table public.leads
      add constraint leads_verification_status_chk
      check (verification_status in ('unverified','mx_only','smtp_verified','manual_verified','bounced'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_source_tier_chk') then
    alter table public.leads
      add constraint leads_source_tier_chk
      check (source_tier in ('unknown','firstparty','verified_api','public_directory','scraped','purchased'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_review_state_chk') then
    alter table public.leads
      add constraint leads_review_state_chk
      check (review_state in ('ready','review','quarantined','approved','discarded'));
  end if;
end $$;

-- Export gate: a lead is eligible only when every precondition holds. Stored
-- so Postgres computes it at insert time and every read path can rely on it
-- without duplicating the rule in SQL. The threshold (>= 60) mirrors the
-- default min_score in scoring and export routes.
alter table public.leads
  add column if not exists export_eligible boolean
  generated always as (
    coalesce(is_scrubbed, false)
    and not coalesce(is_duplicate, false)
    and not coalesce(is_suppressed, false)
    and coalesce(quality_score, 0) >= 60
    and review_state in ('ready','approved')
  ) stored;

create index if not exists idx_leads_export_eligible
  on public.leads (client_id, export_eligible, quality_score desc)
  where export_eligible = true;

create index if not exists idx_leads_review_queue
  on public.leads (client_id, review_state, created_at desc)
  where review_state in ('review','quarantined');

create index if not exists idx_leads_quality_score
  on public.leads (client_id, quality_score desc nulls last);

-- Backfill existing rows so export_eligible stops being stuck at false.
-- We reconstruct the best score/state we can from the scrub signals the row
-- was written with. Future writes go through the scoring helper.
update public.leads
set
  quality_score = least(greatest(coalesce(scrub_score, 0), 0), 100),
  verification_status = case
    when smtp_valid is true then 'smtp_verified'
    when mx_valid is true then 'mx_only'
    when reject_reason in ('smtp_failed','no_mx','bad_syntax','disposable_domain') then 'bounced'
    else 'unverified'
  end,
  source_tier = coalesce(
    (select case s.kind
       when 'apollo'     then 'verified_api'
       when 'commonroom' then 'verified_api'
       when 'hunter'     then 'verified_api'
       when 'firstparty' then 'firstparty'
       when 'scraped'    then 'scraped'
       when 'purchased'  then 'purchased'
       when 'api'        then 'verified_api'
       else 'unknown'
     end
     from public.sources s
     where s.id = leads.source_id),
    'unknown'
  ),
  review_state = case
    when is_suppressed is true
      or is_duplicate is true
      or is_disposable is true
      or syntax_valid is false
      then 'quarantined'
    when coalesce(is_scrubbed, false) and coalesce(scrub_score, 0) >= 60
      then 'ready'
    else 'review'
  end,
  last_scored_at = now()
where quality_score is null;

-- Refresh the client usage view with quality-first surfaces. `monthly_cap`
-- stays on the plan tier; operators get a separate count of how many leads
-- actually made it through the export gate this month.
drop view if exists public.v_client_usage;
create or replace view public.v_client_usage as
select
  c.id as client_id,
  c.plan,
  c.stripe_customer_id,
  c.plan_current_period_end,
  count(l.id) filter (
    where l.created_at >= date_trunc('month', now())
  ) as leads_this_month,
  count(l.id) filter (
    where l.is_scrubbed
      and l.created_at >= date_trunc('month', now())
  ) as clean_this_month,
  count(l.id) filter (
    where l.export_eligible
      and l.created_at >= date_trunc('month', now())
  ) as export_eligible_this_month,
  count(l.id) filter (
    where l.review_state = 'review'
      and l.created_at >= date_trunc('month', now())
  ) as in_review_this_month,
  count(l.id) filter (
    where l.review_state = 'quarantined'
      and l.created_at >= date_trunc('month', now())
  ) as quarantined_this_month,
  count(distinct l.icp_segment) filter (
    where l.created_at >= date_trunc('month', now())
  ) as segments_used_this_month,
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
