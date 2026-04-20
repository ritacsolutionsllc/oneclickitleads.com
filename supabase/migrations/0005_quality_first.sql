-- Quality-first lead pipeline.
--
-- Every lead now carries enough metadata to explain why it is (or is not)
-- allowed to leave the platform:
--
--   quality_score       — canonical 0-100 composite from lib/quality/score.ts
--   reason_codes        — explainable tags populated alongside quality_score
--   verification_status — where the record falls on the identity-proof ladder
--   source_tier         — 1 (first-party) .. 5 (raw scrape) confidence bucket
--   lead_status         — 'review' | 'approved' | 'rejected' workflow state
--   export_eligible     — generated column: DB-enforced export gate
--
-- lead_quality_score (added in 0003) is kept as the Google Places signal
-- ranking helper (rating × rating_count). quality_score is the canonical
-- score the scoring engine produces and what the UI should surface.

alter table public.leads
  add column if not exists quality_score       smallint,
  add column if not exists reason_codes        text[] not null default '{}',
  add column if not exists verification_status text not null default 'unverified',
  add column if not exists source_tier         smallint,
  add column if not exists verified_at         timestamptz,
  add column if not exists last_scored_at      timestamptz,
  add column if not exists lead_status         text not null default 'review';

-- Clamp allowed values so bad writes fail loudly rather than silently.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_lead_status_check'
  ) then
    alter table public.leads
      add constraint leads_lead_status_check
      check (lead_status in ('new','review','approved','exported','rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_verification_status_check'
  ) then
    alter table public.leads
      add constraint leads_verification_status_check
      check (verification_status in (
        'unverified','syntax_only','mx_only','smtp_verified','first_party'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_source_tier_check'
  ) then
    alter table public.leads
      add constraint leads_source_tier_check
      check (source_tier is null or source_tier between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_quality_score_check'
  ) then
    alter table public.leads
      add constraint leads_quality_score_check
      check (quality_score is null or quality_score between 0 and 100);
  end if;
end $$;

-- DB-enforced export gate. Generated so application code cannot flip it
-- accidentally. Export routes must filter on this column.
alter table public.leads
  add column if not exists export_eligible boolean generated always as (
    is_scrubbed is true
    and coalesce(is_duplicate, false)   is false
    and coalesce(is_suppressed, false)  is false
    and coalesce(is_disposable, false)  is false
    and coalesce(quality_score, 0) >= 60
    and (email is not null or phone_e164 is not null)
    and lead_status in ('approved','exported')
  ) stored;

create index if not exists idx_leads_export_eligible
  on public.leads (client_id, export_eligible, quality_score desc)
  where export_eligible = true;

create index if not exists idx_leads_status
  on public.leads (client_id, lead_status, created_at desc);

create index if not exists idx_leads_review_queue
  on public.leads (client_id, lead_status, quality_score desc)
  where lead_status = 'review';

-- Sources keep a tier alongside kind so ingestion can stamp it onto every
-- lead in a batch without re-deriving from the string.
alter table public.sources
  add column if not exists tier smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sources_tier_check'
  ) then
    alter table public.sources
      add constraint sources_tier_check
      check (tier is null or tier between 1 and 5);
  end if;
end $$;

-- Back-fill source tiers for rows created before this migration.
update public.sources set tier = case kind
  when 'firstparty'  then 1
  when 'apollo'      then 2
  when 'commonroom'  then 2
  when 'purchased'   then 3
  when 'hunter'      then 3
  when 'api'         then 3
  when 'scraped'     then 4
  else 5
end
where tier is null;

-- Back-fill lead_status + verification_status for rows created before this
-- migration. Anything is_scrubbed gets 'approved' + mx_only; everything else
-- falls into the review queue so it can't slip into an export.
update public.leads
set
  lead_status = case
    when coalesce(is_disposable, false) or reject_reason = 'bad_syntax' then 'rejected'
    when coalesce(is_duplicate, false)  or coalesce(is_suppressed, false) then 'rejected'
    when is_scrubbed is true then 'approved'
    else 'review'
  end,
  verification_status = case
    when smtp_valid is true then 'smtp_verified'
    when mx_valid  is true then 'mx_only'
    when syntax_valid is true then 'syntax_only'
    else 'unverified'
  end,
  source_tier = coalesce(
    source_tier,
    (select tier from public.sources s where s.id = leads.source_id),
    5
  )
where lead_status = 'review' and quality_score is null;

-- Quality-aware usage view. Clean lead count now means "export_eligible",
-- which is the number that actually matters for billing + capacity planning.
drop view if exists public.v_client_usage;
create or replace view public.v_client_usage as
select
  c.id                             as client_id,
  c.plan,
  c.stripe_customer_id,
  c.plan_current_period_end,
  count(l.id) filter (where l.created_at >= date_trunc('month', now()))
    as leads_this_month,
  count(l.id) filter (where l.is_scrubbed and l.created_at >= date_trunc('month', now()))
    as clean_this_month,
  count(l.id) filter (where l.export_eligible and l.created_at >= date_trunc('month', now()))
    as eligible_this_month,
  count(l.id) filter (where l.lead_status = 'review' and l.created_at >= date_trunc('month', now()))
    as in_review_this_month,
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

-- Per-client quality snapshot the dashboard can poll without sweeping the
-- leads table every page load.
create or replace view public.v_client_quality as
select
  client_id,
  count(*)                                                     as total_leads,
  count(*) filter (where lead_status = 'approved')             as approved,
  count(*) filter (where lead_status = 'review')               as in_review,
  count(*) filter (where lead_status = 'rejected')             as rejected,
  count(*) filter (where export_eligible)                      as export_eligible,
  count(*) filter (where verification_status = 'smtp_verified') as smtp_verified,
  count(*) filter (where verification_status = 'mx_only')      as mx_only,
  count(*) filter (where verification_status = 'first_party')  as first_party,
  round(avg(quality_score) filter (where quality_score is not null), 1) as avg_quality_score
from public.leads
group by client_id;
