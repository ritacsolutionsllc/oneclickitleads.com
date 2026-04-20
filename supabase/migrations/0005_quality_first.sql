-- Quality-first lead scoring
--
-- Six sub-scores (all [0, 1]) combined into a weighted composite (0-100) and
-- a coarse `export_tier` used by /api/export and /api/push/* to decide which
-- leads are eligible. Sub-scores are written by utils/scoring/* at scrub time.
--
-- Weights (must sum to 1.0):
--   identity        0.30  -- email verified, phone valid, name present
--   icp_fit         0.25  -- matches client's ICP segment/geo/firmographic filters
--   completeness    0.20  -- how many fields are populated
--   freshness       0.15  -- how recently verified (decays over 180d)
--   intent          0.07  -- signals of buying/engagement intent
--   source_confidence 0.03 -- source trust tier (first-party=1 best, social=5 worst)

-- =========================================================
-- sources: trust tier
-- =========================================================
alter table public.sources
  add column if not exists trust_tier int not null default 4
    check (trust_tier between 1 and 5);

comment on column public.sources.trust_tier is
  '1=first-party opt-in, 2=api-verified, 3=enriched, 4=public-scraped, 5=social-speculative';

-- =========================================================
-- clients: per-tenant export policy
-- =========================================================
alter table public.clients
  add column if not exists export_policy jsonb not null default jsonb_build_object(
    'premium',     'allow',
    'standard',    'allow',
    'prospecting', 'allow',
    'review',      'manual',
    'hold',        'block',
    'discard',     'block',
    'min_composite_score', 50
  );

comment on column public.clients.export_policy is
  'Per-tier export behaviour: allow (auto-export), manual (review queue only), block (never export). min_composite_score is the hard floor below which nothing exports regardless of tier.';

-- =========================================================
-- leads: sub-scores + composite + tier + verification
-- =========================================================
alter table public.leads
  add column if not exists identity_score       numeric check (identity_score between 0 and 1),
  add column if not exists icp_fit_score        numeric check (icp_fit_score between 0 and 1),
  add column if not exists completeness_score   numeric check (completeness_score between 0 and 1),
  add column if not exists freshness_score      numeric check (freshness_score between 0 and 1),
  add column if not exists intent_score         numeric check (intent_score between 0 and 1),
  add column if not exists source_confidence    numeric check (source_confidence between 0 and 1),
  add column if not exists verified_at          timestamptz,
  add column if not exists verified_by          text,       -- 'neverbounce:valid' | 'zerobounce:risky' | ...
  add column if not exists export_tier          text
    check (export_tier in ('premium','standard','prospecting','review','hold','discard'));

-- composite_score is a stored generated column so it cannot drift from
-- the sub-scores. If weights change, drop + re-add this column.
alter table public.leads
  add column if not exists composite_score numeric
  generated always as (
    (
      coalesce(identity_score,      0) * 0.30 +
      coalesce(icp_fit_score,       0) * 0.25 +
      coalesce(completeness_score,  0) * 0.20 +
      coalesce(freshness_score,     0) * 0.15 +
      coalesce(intent_score,        0) * 0.07 +
      coalesce(source_confidence,   0) * 0.03
    ) * 100
  ) stored;

create index if not exists idx_leads_composite
  on public.leads (client_id, composite_score desc)
  where is_scrubbed = true;

create index if not exists idx_leads_export_tier
  on public.leads (client_id, export_tier)
  where is_scrubbed = true;

create index if not exists idx_leads_verified_at
  on public.leads (client_id, verified_at desc);

-- =========================================================
-- Quality dashboard view
-- =========================================================
-- Per-client rollup used by /dashboard/quality. Counts leads in each tier,
-- plus averages and stale counts. RLS on leads means a client only sees
-- their own row when querying through the API.
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
  avg(l.composite_score)  filter (where l.is_scrubbed)        as avg_composite,
  count(l.id) filter (
    where l.is_scrubbed
      and (l.verified_at is null or l.verified_at < now() - interval '90 days')
  ) as stale_count
from public.clients c
left join public.leads l on l.client_id = c.id
group by c.id;
