-- Quality-first lead schema.
--
-- Every lead now carries an explainable quality score, a verification
-- status, a source tier, an export eligibility verdict, reason codes, and
-- a verification timestamp. Exports only read rows where
-- export_eligibility = 'eligible'; weaker rows land in 'review' or
-- 'quarantine' and never leave the building until an operator approves.
--
-- See utils/scoring/quality.ts for the canonical scoring function.

-- =========================================================
-- leads: quality-first columns
-- =========================================================
alter table public.leads
  add column if not exists quality_score       int,
  add column if not exists verification_status text,
  add column if not exists source_tier         text,
  add column if not exists export_eligibility  text not null default 'review',
  add column if not exists reason_codes        text[] not null default '{}',
  add column if not exists review_status       text not null default 'none',
  add column if not exists reviewed_at         timestamptz,
  add column if not exists reviewed_by         uuid references auth.users(id),
  add column if not exists last_verified_at    timestamptz;

-- Constrain the enums at the DB layer so bad writes fail loudly.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_verification_status_check'
  ) then
    alter table public.leads
      add constraint leads_verification_status_check
      check (
        verification_status is null or verification_status in (
          'unverified', 'syntax_valid', 'mx_valid', 'smtp_verified', 'first_party'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_source_tier_check'
  ) then
    alter table public.leads
      add constraint leads_source_tier_check
      check (source_tier is null or source_tier in ('A', 'B', 'C', 'D'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_export_eligibility_check'
  ) then
    alter table public.leads
      add constraint leads_export_eligibility_check
      check (export_eligibility in ('eligible', 'review', 'quarantine', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_review_status_check'
  ) then
    alter table public.leads
      add constraint leads_review_status_check
      check (review_status in ('none', 'pending', 'approved', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_quality_score_range_check'
  ) then
    alter table public.leads
      add constraint leads_quality_score_range_check
      check (quality_score is null or (quality_score between 0 and 100));
  end if;
end $$;

-- Hot-path indexes for the export query and the review queue.
create index if not exists idx_leads_export_ready
  on public.leads (client_id, quality_score desc)
  where export_eligibility = 'eligible';

create index if not exists idx_leads_review_queue
  on public.leads (client_id, created_at desc)
  where export_eligibility in ('review', 'quarantine');

create index if not exists idx_leads_verification
  on public.leads (client_id, verification_status);

create index if not exists idx_leads_source_tier
  on public.leads (client_id, source_tier);

-- =========================================================
-- Backfill for existing rows.
--
-- This mirrors the canonical TS scoring logic closely enough that
-- pre-migration rows stop silently exporting as raw. The ingest paths
-- will overwrite these fields the next time a lead is touched.
-- =========================================================
update public.leads
set
  verification_status = case
    when smtp_valid is true then 'smtp_verified'
    when mx_valid   is true then 'mx_valid'
    when syntax_valid is true then 'syntax_valid'
    else 'unverified'
  end
where verification_status is null;

-- Best-effort source tier from the sources.kind lookup. Unknown kinds
-- default to 'D' (scraped) so we never over-promise source confidence.
update public.leads l
set source_tier = case s.kind
    when 'firstparty'  then 'A'
    when 'apollo'      then 'B'
    when 'commonroom'  then 'B'
    when 'purchased'   then 'B'
    when 'api'         then 'B'
    when 'hunter'      then 'B'
    when 'scraped'     then 'C'
    when 'osm'         then 'C'
    else 'D'
  end
from public.sources s
where l.source_id = s.id and l.source_tier is null;

update public.leads
set source_tier = 'D'
where source_tier is null;

-- Conservative backfill: honour the old is_scrubbed boolean as the first
-- pass at eligibility, then clamp rejects/suppressions/duplicates.
update public.leads
set export_eligibility = case
    when is_suppressed is true or is_duplicate is true or is_disposable is true
      or syntax_valid is false
      then 'rejected'
    when is_scrubbed is true
      then 'eligible'
    else 'review'
  end
where export_eligibility = 'review' and (
  is_scrubbed is true or is_suppressed is true or is_duplicate is true
    or is_disposable is true or syntax_valid is false
);

update public.leads
set last_verified_at = coalesce(last_verified_at, scrubbed_at, created_at)
where last_verified_at is null;

-- =========================================================
-- v_client_usage: count eligibility, not raw volume.
--
-- The export gate and dashboard now read clean_this_month as the count
-- of EXPORT-eligible leads, not just "is_scrubbed". Keeps billing and
-- caps honest to the quality-first promise.
-- =========================================================
drop view if exists public.v_client_usage;
create or replace view public.v_client_usage as
select
  c.id as client_id,
  c.plan,
  c.stripe_customer_id,
  c.plan_current_period_end,
  count(l.id) filter (where l.created_at >= date_trunc('month', now())) as leads_this_month,
  count(l.id) filter (
    where l.export_eligibility = 'eligible'
      and l.created_at >= date_trunc('month', now())
  ) as clean_this_month,
  count(l.id) filter (
    where l.export_eligibility = 'review'
      and l.created_at >= date_trunc('month', now())
  ) as review_this_month,
  count(l.id) filter (
    where l.export_eligibility = 'quarantine'
      and l.created_at >= date_trunc('month', now())
  ) as quarantine_this_month,
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

-- =========================================================
-- RLS: let a client owner UPDATE their own leads so the review queue
-- (approve / reject / requeue) actions work through the anon client.
-- Reads and inserts were already covered in 0001_init.sql.
-- =========================================================
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'leads'
      and policyname = 'leads_owner_update'
  ) then
    create policy "leads_owner_update"
      on public.leads for update
      using (client_id in (select id from public.clients where owner_user = auth.uid()))
      with check (client_id in (select id from public.clients where owner_user = auth.uid()));
  end if;
end $$;

-- =========================================================
-- v_client_quality: quick quality breakdown for the dashboard.
-- =========================================================
create or replace view public.v_client_quality as
select
  c.id as client_id,
  c.slug,
  count(l.id) as total_leads,
  count(l.id) filter (where l.export_eligibility = 'eligible')   as eligible,
  count(l.id) filter (where l.export_eligibility = 'review')     as needs_review,
  count(l.id) filter (where l.export_eligibility = 'quarantine') as quarantined,
  count(l.id) filter (where l.export_eligibility = 'rejected')   as rejected,
  count(l.id) filter (where l.source_tier = 'A') as tier_a,
  count(l.id) filter (where l.source_tier = 'B') as tier_b,
  count(l.id) filter (where l.source_tier = 'C') as tier_c,
  count(l.id) filter (where l.source_tier = 'D') as tier_d,
  count(l.id) filter (where l.verification_status = 'smtp_verified') as smtp_verified,
  count(l.id) filter (where l.verification_status = 'first_party')   as first_party,
  avg(l.quality_score) filter (where l.export_eligibility = 'eligible') as avg_quality_eligible,
  max(l.created_at) as last_ingested_at
from public.clients c
left join public.leads l on l.client_id = c.id
group by c.id, c.slug;
