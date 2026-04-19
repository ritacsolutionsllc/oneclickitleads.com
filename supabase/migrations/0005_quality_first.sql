-- Quality-first lead model.
--
-- Introduces the fields the export gate, review queue, and dashboard quality
-- surfaces all key off of. Every lead that lives in the system will have:
--   - a unified `quality_score` (0-100) with an explainable `quality_tier`
--   - a `verification_status` independent of the raw scrub flags
--   - a `source_tier` (1 best, 4 worst) derived from where it came from
--   - a boolean `export_eligible` that the export route enforces
--   - an array of `reason_codes` the UI renders as chips
--   - a `review_state` machine for the quarantine/approve queue
--   - `verified_at` / `reviewed_at` timestamps for freshness + audit
--
-- The scoring values themselves are written by the scoring engine in
-- `utils/scoring/score.ts`. The DB only enforces shape + defaults.

-- =========================================================
-- sources: tier label so the scoring engine doesn't have to
-- pattern-match on `kind` in application code.
-- =========================================================
alter table public.sources
  add column if not exists tier int not null default 3;

comment on column public.sources.tier is
  '1=first-party, 2=paid API (Apollo/CommonRoom), 3=directory (Places/OSM/Hunter), 4=open scrape';

update public.sources set tier = case kind
  when 'firstparty'  then 1
  when 'apollo'      then 2
  when 'commonroom'  then 2
  when 'api'         then 2
  when 'purchased'   then 3
  when 'scraped'     then 4
  else 3
end
where tier = 3;

-- =========================================================
-- leads: quality-first columns
-- =========================================================
alter table public.leads
  add column if not exists quality_score       int,
  add column if not exists quality_tier        text,
  add column if not exists verification_status text,
  add column if not exists source_tier         int,
  add column if not exists export_eligible     boolean not null default false,
  add column if not exists reason_codes        text[]  not null default '{}',
  add column if not exists review_state        text    not null default 'pending',
  add column if not exists verified_at         timestamptz,
  add column if not exists reviewed_at         timestamptz,
  add column if not exists reviewed_by         uuid references auth.users(id);

-- Allowed value guards. Kept as CHECK constraints so bad writes surface at
-- the DB layer, not silently downstream.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_quality_tier_chk') then
    alter table public.leads
      add constraint leads_quality_tier_chk
      check (quality_tier is null or quality_tier in ('A','B','C','D','F'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_verification_status_chk') then
    alter table public.leads
      add constraint leads_verification_status_chk
      check (verification_status is null or verification_status in ('verified','probable','unverified','failed'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_review_state_chk') then
    alter table public.leads
      add constraint leads_review_state_chk
      check (review_state in ('approved','pending','quarantined','rejected'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_source_tier_chk') then
    alter table public.leads
      add constraint leads_source_tier_chk
      check (source_tier is null or source_tier between 1 and 4);
  end if;
end $$;

-- Hot paths: export filter, review queue, dashboard quality distribution.
create index if not exists idx_leads_export_eligible
  on public.leads (client_id, export_eligible, quality_score desc)
  where export_eligible = true;

create index if not exists idx_leads_review_state
  on public.leads (client_id, review_state, created_at desc)
  where review_state in ('pending','quarantined');

create index if not exists idx_leads_quality_tier
  on public.leads (client_id, quality_tier);

-- =========================================================
-- Backfill so existing data still flows through export.
-- Rules:
--   - is_scrubbed=true  → approved + export_eligible + verified/probable
--   - is_disposable/bad_syntax → rejected
--   - otherwise → quarantined
-- Scores are best-effort derived from the old per-email `scrub_score` plus
-- completeness. The scoring engine will overwrite these on the next touch.
-- =========================================================
update public.leads l
set
  source_tier = coalesce(s.tier, 3)
from public.sources s
where l.source_id = s.id
  and l.source_tier is null;

update public.leads
set source_tier = 3
where source_tier is null;

update public.leads
set
  verification_status = case
    when smtp_valid is true then 'verified'
    when mx_valid   is true then 'probable'
    when syntax_valid is true then 'unverified'
    else 'failed'
  end
where verification_status is null;

update public.leads
set
  quality_score = least(100, greatest(0,
    coalesce(scrub_score, 0)
    + case when first_name is not null then 3 else 0 end
    + case when company    is not null then 4 else 0 end
    + case when phone_e164 is not null then 3 else 0 end
    + case when city       is not null then 2 else 0 end
    + case when title      is not null then 2 else 0 end
    + case when icp_segment is not null then 3 else 0 end
  ))
where quality_score is null;

update public.leads
set quality_tier = case
  when quality_score >= 85 then 'A'
  when quality_score >= 70 then 'B'
  when quality_score >= 55 then 'C'
  when quality_score >= 30 then 'D'
  else 'F'
end
where quality_tier is null;

update public.leads
set
  export_eligible = (
    is_scrubbed = true
    and coalesce(is_disposable,false) = false
    and coalesce(is_duplicate,false)  = false
    and coalesce(is_suppressed,false) = false
    and quality_score >= 70
  ),
  review_state = case
    when coalesce(is_disposable,false) or reject_reason = 'bad_syntax' then 'rejected'
    when coalesce(is_suppressed,false) then 'rejected'
    when is_scrubbed = true and quality_score >= 70 then 'approved'
    when is_scrubbed = true then 'pending'
    else 'quarantined'
  end,
  verified_at = case
    when smtp_valid is true and verified_at is null then scrubbed_at
    else verified_at
  end
where review_state = 'pending';

-- =========================================================
-- v_client_usage: bill/cap on export-eligible, not raw scrub.
-- Dashboard quality surfaces read from this too.
-- =========================================================
drop view if exists public.v_client_usage;
create or replace view public.v_client_usage as
select
  c.id as client_id,
  c.plan,
  c.stripe_customer_id,
  c.plan_current_period_end,
  count(l.id) filter (where l.created_at >= date_trunc('month', now())) as leads_this_month,
  count(l.id) filter (where l.is_scrubbed and l.created_at >= date_trunc('month', now())) as clean_this_month,
  count(l.id) filter (where l.export_eligible and l.created_at >= date_trunc('month', now())) as eligible_this_month,
  count(l.id) filter (where l.review_state = 'pending') as review_pending,
  count(l.id) filter (where l.review_state = 'quarantined') as review_quarantined,
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
-- v_lead_quality_summary: A/B/C/D/F distribution for dashboard quality page.
-- =========================================================
create or replace view public.v_lead_quality_summary as
select
  client_id,
  quality_tier,
  review_state,
  count(*)::int as count,
  round(avg(quality_score))::int as avg_score
from public.leads
where quality_tier is not null
group by client_id, quality_tier, review_state;

-- =========================================================
-- RLS policies for the review queue.
--   - leads UPDATE: owner of the client can update their leads (approve /
--     reject / requeue / rescore actions from /api/review/action).
--   - lead_events INSERT + SELECT: owner writes audit rows, owner reads
--     history. No UPDATE/DELETE — the audit trail is append-only.
-- =========================================================
drop policy if exists "leads_owner_update" on public.leads;
create policy "leads_owner_update"
  on public.leads for update
  using (client_id in (select id from public.clients where owner_user = auth.uid()))
  with check (client_id in (select id from public.clients where owner_user = auth.uid()));

drop policy if exists "lead_events_owner_read" on public.lead_events;
create policy "lead_events_owner_read"
  on public.lead_events for select
  using (
    exists (
      select 1
      from public.leads l
      join public.clients c on c.id = l.client_id
      where l.id = lead_events.lead_id
        and c.owner_user = auth.uid()
    )
  );

drop policy if exists "lead_events_owner_insert" on public.lead_events;
create policy "lead_events_owner_insert"
  on public.lead_events for insert
  with check (
    exists (
      select 1
      from public.leads l
      join public.clients c on c.id = l.client_id
      where l.id = lead_events.lead_id
        and c.owner_user = auth.uid()
    )
  );
