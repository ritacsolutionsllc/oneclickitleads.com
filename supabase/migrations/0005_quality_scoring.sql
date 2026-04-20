-- Quality-first scoring + export gating
--
-- Every lead now carries an explicit quality score, verification status,
-- source tier, export eligibility, and a list of reason codes explaining
-- the outcome. Export paths filter on export_eligibility; weak/risky rows
-- land in the review queue instead of being silently dropped.
--
-- Run with: supabase db push

-- =========================================================
-- Leads: scoring + gating columns
-- =========================================================
alter table public.leads
  add column if not exists quality_score        int,
  add column if not exists verification_status  text,  -- 'unverified'|'syntax_only'|'mx_verified'|'smtp_verified'|'failed'
  add column if not exists source_tier          text,  -- 'firstparty'|'verified_api'|'directory'|'scraped'|'purchased'|'unknown'
  add column if not exists export_eligibility   text not null default 'review',
                                                      -- 'eligible'|'review'|'quarantined'|'suppressed'|'exported'
  add column if not exists reason_codes         text[] not null default '{}',
  add column if not exists verified_at          timestamptz,
  add column if not exists review_state         text not null default 'none',
                                                      -- 'none'|'pending'|'approved'|'rejected'
  add column if not exists review_notes         text,
  add column if not exists reviewed_by          uuid references auth.users(id),
  add column if not exists reviewed_at          timestamptz;

-- =========================================================
-- Constraints
-- =========================================================
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_quality_score_range') then
    alter table public.leads
      add constraint leads_quality_score_range
      check (quality_score is null or (quality_score between 0 and 100));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_export_eligibility_values') then
    alter table public.leads
      add constraint leads_export_eligibility_values
      check (export_eligibility in ('eligible','review','quarantined','suppressed','exported'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_review_state_values') then
    alter table public.leads
      add constraint leads_review_state_values
      check (review_state in ('none','pending','approved','rejected'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_verification_status_values') then
    alter table public.leads
      add constraint leads_verification_status_values
      check (
        verification_status is null or
        verification_status in ('unverified','syntax_only','mx_verified','smtp_verified','failed')
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_source_tier_values') then
    alter table public.leads
      add constraint leads_source_tier_values
      check (
        source_tier is null or
        source_tier in ('firstparty','verified_api','directory','scraped','purchased','unknown')
      );
  end if;
end$$;

-- =========================================================
-- Indexes
-- =========================================================
create index if not exists idx_leads_export_eligibility
  on public.leads (client_id, export_eligibility);

create index if not exists idx_leads_quality_score
  on public.leads (client_id, quality_score desc nulls last)
  where export_eligibility = 'eligible';

create index if not exists idx_leads_review_state
  on public.leads (client_id, review_state)
  where review_state <> 'none';

create index if not exists idx_leads_source_tier
  on public.leads (client_id, source_tier);

-- =========================================================
-- Sources: mirror the tier so we can audit + filter batches
-- =========================================================
alter table public.sources
  add column if not exists tier text;  -- 'firstparty'|'verified_api'|'directory'|'scraped'|'purchased'|'unknown'

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sources_tier_values') then
    alter table public.sources
      add constraint sources_tier_values
      check (
        tier is null or
        tier in ('firstparty','verified_api','directory','scraped','purchased','unknown')
      );
  end if;
end$$;

-- Backfill: infer the tier from existing source kinds
update public.sources set tier = case
  when kind in ('firstparty','shopify','klaviyo') then 'firstparty'
  when kind in ('apollo','commonroom','hunter','snov','zoominfo') then 'verified_api'
  when kind in ('places','google_places','osm','directory','api') then 'directory'
  when kind in ('scraped','webscraping','scrapingbee','brightdata') then 'scraped'
  when kind in ('purchased','list') then 'purchased'
  else 'unknown'
end
where tier is null;

-- =========================================================
-- Backfill leads: derive eligibility from existing columns so
-- nothing in prod silently becomes exportable when the new code
-- lands. Anything already scrubbed stays eligible; everything
-- else drops into the review queue.
-- =========================================================
update public.leads set
  export_eligibility = case
    when is_suppressed                           then 'suppressed'
    when is_duplicate or is_disposable           then 'quarantined'
    when is_scrubbed and coalesce(scrub_score,0) >= 60 then 'eligible'
    else 'review'
  end,
  verification_status = case
    when smtp_valid  is true                     then 'smtp_verified'
    when mx_valid    is true                     then 'mx_verified'
    when syntax_valid is true                    then 'syntax_only'
    when syntax_valid is false                   then 'failed'
    else 'unverified'
  end,
  quality_score = coalesce(scrub_score, 0)
where quality_score is null;

-- =========================================================
-- Dashboard-facing quality view
-- =========================================================
create or replace view public.v_client_quality as
select
  c.id                                                                as client_id,
  c.slug,
  count(l.id)                                                         as total_leads,
  count(l.id) filter (where l.export_eligibility = 'eligible')        as eligible_leads,
  count(l.id) filter (where l.export_eligibility = 'review')          as review_leads,
  count(l.id) filter (where l.export_eligibility = 'quarantined')     as quarantined_leads,
  count(l.id) filter (where l.export_eligibility = 'suppressed')      as suppressed_leads,
  count(l.id) filter (where l.verification_status = 'smtp_verified')  as smtp_verified_leads,
  count(l.id) filter (where l.verification_status = 'mx_verified')    as mx_verified_leads,
  count(l.id) filter (where l.source_tier = 'firstparty')             as firstparty_leads,
  count(l.id) filter (where l.source_tier = 'scraped')                as scraped_leads,
  coalesce(avg(l.quality_score) filter (where l.quality_score is not null), 0)::int
                                                                      as avg_quality_score,
  count(l.id) filter (where l.review_state = 'pending')               as pending_review_count
from public.clients c
left join public.leads l on l.client_id = c.id
group by c.id, c.slug;

-- =========================================================
-- Reason-code distribution view (what's killing exportability)
-- =========================================================
create or replace view public.v_client_reason_codes as
select
  l.client_id,
  code,
  count(*) as occurrences
from public.leads l, unnest(l.reason_codes) as code
group by l.client_id, code;

-- =========================================================
-- Suppression propagation
-- New suppression rows should retroactively poison matching leads so the
-- next export query filters them out without scanning suppressions.
-- =========================================================
create or replace function public.fn_suppress_matching_leads()
returns trigger
language plpgsql
as $$
begin
  update public.leads l
  set
    export_eligibility = 'suppressed',
    is_suppressed       = true,
    reason_codes        = array(
      select distinct unnest(coalesce(l.reason_codes, '{}'::text[]) || array['suppressed'])
    )
  where l.client_id = new.client_id
    and (
      (new.email is not null and lower(l.email::text) = lower(new.email::text))
      or (new.phone is not null and l.phone_e164 = new.phone)
    );
  return new;
end;
$$;

drop trigger if exists trg_suppress_matching_leads on public.suppressions;
create trigger trg_suppress_matching_leads
  after insert on public.suppressions
  for each row
  execute function public.fn_suppress_matching_leads();
