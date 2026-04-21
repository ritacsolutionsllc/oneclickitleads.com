-- Quality-first: explainable scoring + review/quarantine state
--
-- Everything in this migration exists to make lead outcomes explainable and
-- gated. Before this migration a lead had a composite_score + export_tier but
-- no record of *why* it landed where it did and no operator-visible state for
-- the "review" tier. After this migration:
--
--   * `leads.reason_codes` is the canonical list of score/tier reasons,
--     written by utils/scoring + utils/scrub.
--   * `leads.review_state` tracks operator decisions on review-tier leads.
--   * `v_client_review_queue` surfaces everything waiting on manual review.
--   * `v_client_quality` is extended with a pending-review count so the
--     dashboard can show the backlog without another query.
--
-- Review state lifecycle:
--   auto             -- default: tier is authoritative, no operator action needed
--   pending          -- export_tier = 'review', waiting for operator decision
--   approved         -- operator says ship it (overrides 'review' in exports)
--   rejected         -- operator says drop it (forces export as 'discard')
--   needs_reverify   -- operator says re-run scrub/verification before deciding
--
-- Trust tiers on sources are already in 0005; this migration only leans on
-- them rather than redefining.

-- =========================================================
-- leads: reason codes + review state
-- =========================================================
alter table public.leads
  add column if not exists reason_codes text[] not null default '{}',
  add column if not exists review_state text not null default 'auto'
    check (review_state in ('auto','pending','approved','rejected','needs_reverify')),
  add column if not exists reviewed_at   timestamptz,
  add column if not exists reviewed_by   uuid references auth.users(id),
  add column if not exists review_notes  text;

comment on column public.leads.reason_codes is
  'Stable, machine-readable tags describing why this lead scored/tiered the way it did. Emitted by utils/scoring and utils/scrub. Examples: identity_verified, no_mx, icp_mismatch, stale_verification, source_social_speculative, below_policy_floor.';

comment on column public.leads.review_state is
  'Operator decision on the lead. Defaults to auto (tier is authoritative). Review-tier leads start as pending; operator transitions to approved/rejected/needs_reverify via /api/review.';

-- Fast lookup for the review queue ("show me everyone waiting").
create index if not exists idx_leads_review_queue
  on public.leads (client_id, review_state, composite_score desc)
  where review_state = 'pending';

-- Optional GIN index on reason_codes for "leads with X reason" queries. Only
-- useful once we have >10k rows, but cheap to add now.
create index if not exists idx_leads_reason_codes_gin
  on public.leads using gin (reason_codes);

-- =========================================================
-- Review queue view
-- =========================================================
-- Everything currently waiting on a manual approve/reject. The UI hits this
-- view (or /api/review/queue) rather than filtering leads directly so we can
-- evolve the "what counts as pending" rule in one place.
create or replace view public.v_client_review_queue as
select
  l.id               as lead_id,
  l.client_id,
  l.email,
  l.first_name,
  l.last_name,
  l.company,
  l.icp_segment,
  l.city,
  l.region,
  l.country,
  l.composite_score,
  l.export_tier,
  l.review_state,
  l.reason_codes,
  l.verified_at,
  l.created_at
from public.leads l
where l.review_state = 'pending'
  and l.export_tier  = 'review';

alter view public.v_client_review_queue set (security_invoker = true);

-- =========================================================
-- Extend v_client_quality with a pending-review count
-- =========================================================
-- Keeps one query for the dashboard header. `pending_review` is the queue
-- depth; `approved_ready` is operator-approved review leads that are now
-- eligible for the next export.
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
  count(l.id) filter (
    where l.export_tier = 'review' and l.review_state = 'pending'
  ) as pending_review,
  count(l.id) filter (
    where l.export_tier = 'review' and l.review_state = 'approved'
  ) as approved_ready,
  count(l.id) filter (where l.review_state = 'rejected') as rejected_count,
  avg(l.composite_score)  filter (where l.is_scrubbed)        as avg_composite,
  count(l.id) filter (
    where l.is_scrubbed
      and (l.verified_at is null or l.verified_at < now() - interval '90 days')
  ) as stale_count
from public.clients c
left join public.leads l on l.client_id = c.id
group by c.id;

alter view public.v_client_quality set (security_invoker = true);

-- =========================================================
-- RLS: review queue view + write policies on leads
-- =========================================================
-- An owner can update review_state/reviewed_by/review_notes on their own
-- leads. Other columns stay read-only from the client — scoring fields are
-- written by the admin client.
drop policy if exists "leads_owner_review" on public.leads;
create policy "leads_owner_review"
  on public.leads for update
  using (client_id in (select id from public.clients where owner_user = auth.uid()))
  with check (client_id in (select id from public.clients where owner_user = auth.uid()));

-- =========================================================
-- Backfill: any rows created before this migration get review_state = auto
-- if their tier isn't review, or pending if it is. Safe to re-run.
-- =========================================================
update public.leads
set review_state = 'pending'
where export_tier = 'review'
  and review_state = 'auto';
