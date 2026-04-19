-- Quality-first schema
--
-- Every lead must carry enough metadata to answer, in SQL:
--   - how sure are we this record is real?     (verification_status, quality_score)
--   - where did it come from?                   (source_id -> sources.tier)
--   - can it be exported right now?             (export_eligibility)
--   - why did the scorer rate it that way?      (reason_codes)
--   - is an operator still supposed to act?     (review_status)
--
-- The canonical scoring logic lives in utils/quality/score.ts — this migration
-- is just the storage layer and the views that operators/export routes hit.

-- -----------------------------------------------------------------------------
-- sources: every batch declares the provenance tier of its upstream.
--   a = first-party (own CRM, submitted with consent)
--   b = verified API (Apollo, Hunter/Snov with verification)
--   c = enrichment/directory (Google Places, OSM, purchased list)
--   d = raw scrape (webscraping.ai, Instagram bio, HTML extraction)
-- -----------------------------------------------------------------------------
alter table public.sources
  add column if not exists tier text not null default 'c'
    check (tier in ('a', 'b', 'c', 'd'));

comment on column public.sources.tier is
  'Provenance tier: a=first-party, b=verified api, c=directory/enrichment, d=raw scrape';

-- -----------------------------------------------------------------------------
-- leads: quality-first columns
-- -----------------------------------------------------------------------------
alter table public.leads
  add column if not exists quality_score       int
    check (quality_score is null or (quality_score between 0 and 100)),
  add column if not exists verification_status text not null default 'unverified'
    check (verification_status in (
      'unverified', 'email_syntax', 'email_mx', 'email_smtp',
      'phone_only', 'multi_channel', 'failed'
    )),
  add column if not exists source_tier         text
    check (source_tier is null or source_tier in ('a', 'b', 'c', 'd')),
  add column if not exists export_eligibility  text not null default 'review'
    check (export_eligibility in ('eligible', 'review', 'quarantine')),
  add column if not exists reason_codes        text[] not null default '{}',
  add column if not exists verified_at         timestamptz,
  add column if not exists review_status       text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected', 'retry'));

comment on column public.leads.quality_score is
  '0-100 canonical quality score from utils/quality/score.ts';
comment on column public.leads.verification_status is
  'unverified | email_syntax | email_mx | email_smtp | phone_only | multi_channel | failed';
comment on column public.leads.source_tier is
  'Snapshot of sources.tier at insert time (a/b/c/d)';
comment on column public.leads.export_eligibility is
  'eligible | review | quarantine — export API only emits eligible';
comment on column public.leads.reason_codes is
  'Machine-readable score explanations — see utils/quality/score.ts ReasonCode';
comment on column public.leads.review_status is
  'pending | approved | rejected | retry — operator decision state';

create index if not exists idx_leads_eligibility
  on public.leads (client_id, export_eligibility, quality_score desc nulls last);

create index if not exists idx_leads_review_pending
  on public.leads (client_id, created_at)
  where review_status = 'pending' and export_eligibility in ('review', 'quarantine');

-- -----------------------------------------------------------------------------
-- v_client_usage: now tracks eligibility breakdown per month so the dashboard
-- can show "clean vs review vs quarantine" instead of raw volume.
-- -----------------------------------------------------------------------------
drop view if exists public.v_client_usage;
create or replace view public.v_client_usage as
select
  c.id as client_id,
  c.plan,
  c.stripe_customer_id,
  c.plan_current_period_end,
  count(l.id) filter (where l.created_at >= date_trunc('month', now()))
    as leads_this_month,
  count(l.id) filter (where l.is_scrubbed and l.created_at >= date_trunc('month', now()))
    as clean_this_month,
  count(l.id) filter (where l.export_eligibility = 'eligible' and l.created_at >= date_trunc('month', now()))
    as eligible_this_month,
  count(l.id) filter (where l.export_eligibility = 'review' and l.created_at >= date_trunc('month', now()))
    as review_this_month,
  count(l.id) filter (where l.export_eligibility = 'quarantine' and l.created_at >= date_trunc('month', now()))
    as quarantine_this_month,
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
