-- Quality-first lead schema.
--
-- Every lead must carry its own explanation: how confident we are it's real
-- (quality_score), why (reason_codes), where it came from (source_tier),
-- whether it can leave the platform (export_eligible), and what an operator
-- should do with it (review_state). Export and push routes gate on these
-- columns rather than the older is_scrubbed heuristic.

-- =========================================================
-- leads: quality + eligibility + review fields
-- =========================================================
alter table public.leads
  add column if not exists quality_score        int,
  add column if not exists quality_tier         text,         -- 'gold' | 'silver' | 'bronze' | 'review' | 'rejected'
  add column if not exists verification_status  text,         -- 'verified' | 'unverified' | 'failed' | 'pending'
  add column if not exists verified_at          timestamptz,
  add column if not exists source_tier          text,         -- 'tier1' | 'tier2' | 'tier3'
  add column if not exists export_eligible      boolean not null default false,
  add column if not exists export_blocked_reason text,
  add column if not exists reason_codes         text[] not null default '{}',
  add column if not exists review_state         text not null default 'none',  -- 'none' | 'pending' | 'quarantined' | 'approved' | 'rejected'
  add column if not exists review_notes         text,
  add column if not exists icp_fit_score        int,
  add column if not exists quality_scored_at    timestamptz;

create index if not exists idx_leads_export_eligible
  on public.leads (client_id, export_eligible, quality_score desc)
  where export_eligible = true;

create index if not exists idx_leads_review_state
  on public.leads (client_id, review_state)
  where review_state <> 'none';

create index if not exists idx_leads_quality_tier
  on public.leads (client_id, quality_tier);

-- Backfill: nothing leaves the platform until the scoring engine has run.
-- Existing scrubbed rows stay scrubbed, but export_eligible stays false
-- until they are re-scored by the new pipeline.
update public.leads
   set review_state = coalesce(review_state, 'pending')
 where review_state is null;

-- =========================================================
-- lead_quality_events: audit every score change
-- =========================================================
create table if not exists public.lead_quality_events (
  id              uuid primary key default uuid_generate_v4(),
  lead_id         uuid not null references public.leads(id) on delete cascade,
  client_id       uuid not null references public.clients(id) on delete cascade,
  quality_score   int,
  quality_tier    text,
  export_eligible boolean,
  reason_codes    text[] not null default '{}',
  context         jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_lead_quality_events_lead
  on public.lead_quality_events (lead_id, created_at desc);

alter table public.lead_quality_events enable row level security;

create policy "lead_quality_events: owner read"
  on public.lead_quality_events for select
  using (client_id in (select id from public.clients where owner_user = auth.uid()));

-- =========================================================
-- Export-eligible view for the /api/export + push paths.
-- Centralizes the "what can leave the system" query so route handlers
-- don't re-implement gating logic.
-- =========================================================
create or replace view public.v_export_eligible_leads as
  select l.*
    from public.leads l
   where l.export_eligible = true
     and l.review_state in ('none', 'approved');

-- =========================================================
-- Usage view: measure export-eligible this month for plan caps.
-- Legacy clean_this_month is kept for backwards compat with the dashboard.
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
  count(l.id) filter (where l.review_state in ('pending', 'quarantined') and l.created_at >= date_trunc('month', now())) as review_this_month,
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
