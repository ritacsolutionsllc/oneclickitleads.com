-- Quality-first: review queue, reason codes, per-tenant ICP targets
--
-- Goals:
--   1. Make every lead's score explainable: persist machine-readable
--      `reason_codes` alongside the composite score so the UI and exports
--      can answer "why is this lead in tier X?".
--   2. Promote review state from a coarse export_tier hint to a real
--      operator-facing field (`review_state`) with an audit trail
--      (`lead_review_decisions`).
--   3. Give every client a canonical place to declare their ICP targets
--      (`clients.icp_targets`) so ingest paths can score icp_fit without
--      hard-coded tables.

-- =========================================================
-- clients.icp_targets — declared ICP segments
-- =========================================================
alter table public.clients
  add column if not exists icp_targets text[] not null default '{}';

comment on column public.clients.icp_targets is
  'Declared ICP segments for this tenant, used by scoring.icp_fit. Example: {b2c_beauty, salon, retailer}.';

-- Backfill Chella's targets so existing flows match the previous hard-coded behaviour.
update public.clients
   set icp_targets = '{b2c_beauty,salon,retailer,influencer}'
 where slug = 'chella'
   and (icp_targets is null or array_length(icp_targets, 1) is null);

-- =========================================================
-- leads.reason_codes — machine-readable score explanations
-- =========================================================
alter table public.leads
  add column if not exists reason_codes text[] not null default '{}';

create index if not exists idx_leads_reason_codes
  on public.leads using gin (reason_codes);

comment on column public.leads.reason_codes is
  'Stable score-explanation codes (EMAIL_INVALID, NO_PHONE, OUT_OF_ICP, STALE_VERIFICATION, ...). Append-only — UI joins on these to render badges.';

-- =========================================================
-- leads.review_state — operator-facing queue state
-- =========================================================
alter table public.leads
  add column if not exists review_state text
    check (review_state in (
      'auto_approved',  -- tier policy = allow, exported without operator review
      'needs_review',   -- tier policy = manual, sits in the review queue
      'approved',       -- operator approved manually
      'rejected',       -- operator rejected
      'on_hold',        -- tier policy = block (e.g. hold tier), waiting for re-verification
      'discarded'       -- suppressed/duplicate/below floor — never exportable
    )),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id);

create index if not exists idx_leads_review_state
  on public.leads (client_id, review_state)
  where review_state is not null;

comment on column public.leads.review_state is
  'Operator queue state. Defaulted from export_tier + client.export_policy at scrub time, mutated by review actions.';

-- Backfill review_state from existing export_tier so the new column isn't
-- empty for already-ingested leads. This is a coarse mapping; the ingest
-- pipeline writes a more accurate state on new rows.
update public.leads
   set review_state = case
     when is_suppressed or is_duplicate then 'discarded'
     when export_tier = 'discard' then 'discarded'
     when export_tier = 'hold' then 'on_hold'
     when export_tier = 'review' then 'needs_review'
     when export_tier in ('premium', 'standard', 'prospecting') then 'auto_approved'
     else null
   end
 where review_state is null
   and export_tier is not null;

-- =========================================================
-- lead_review_decisions — full audit trail
-- =========================================================
create table if not exists public.lead_review_decisions (
  id          uuid primary key default uuid_generate_v4(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  decision    text not null check (decision in (
    'approve', 'reject', 'hold', 'requeue', 'rescore', 'reverify'
  )),
  prev_state  text,
  next_state  text,
  reason      text,
  decided_by  uuid references auth.users(id),
  decided_at  timestamptz not null default now()
);

create index if not exists idx_review_decisions_lead
  on public.lead_review_decisions (lead_id, decided_at desc);

create index if not exists idx_review_decisions_client
  on public.lead_review_decisions (client_id, decided_at desc);

alter table public.lead_review_decisions enable row level security;

drop policy if exists "review_decisions_owner_read" on public.lead_review_decisions;
create policy "review_decisions_owner_read"
  on public.lead_review_decisions for select
  using (client_id in (select id from public.clients where owner_user = auth.uid()));

drop policy if exists "review_decisions_owner_insert" on public.lead_review_decisions;
create policy "review_decisions_owner_insert"
  on public.lead_review_decisions for insert
  with check (
    client_id in (select id from public.clients where owner_user = auth.uid())
    and (decided_by is null or decided_by = auth.uid())
  );

-- =========================================================
-- v_client_quality — extend with review-state counts
-- =========================================================
-- security_invoker carries through from 0006 because this is CREATE OR REPLACE.
create or replace view public.v_client_quality as
select
  c.id                                                        as client_id,
  count(l.id) filter (where l.is_scrubbed)                    as scrubbed_total,
  count(l.id) filter (where l.export_tier = 'premium')        as tier_premium,
  count(l.id) filter (where l.export_tier = 'standard')       as tier_standard,
  count(l.id) filter (where l.export_tier = 'prospecting')    as tier_prospecting,
  count(l.id) filter (where l.export_tier = 'review')         as tier_review,
  count(l.id) filter (where l.export_tier = 'hold')           as tier_hold,
  count(l.id) filter (where l.export_tier = 'discard')        as tier_discard,
  count(l.id) filter (where l.review_state = 'needs_review')  as review_pending,
  count(l.id) filter (where l.review_state = 'approved')      as review_approved,
  count(l.id) filter (where l.review_state = 'rejected')      as review_rejected,
  count(l.id) filter (where l.review_state = 'on_hold')       as review_on_hold,
  avg(l.composite_score)  filter (where l.is_scrubbed)        as avg_composite,
  count(l.id) filter (
    where l.is_scrubbed
      and (l.verified_at is null or l.verified_at < now() - interval '90 days')
  ) as stale_count
from public.clients c
left join public.leads l on l.client_id = c.id
group by c.id;

alter view public.v_client_quality set (security_invoker = true);
