-- Quality-first follow-up: make ICP targets + export policy queryable per client
-- so the scoring engine can read them at ingest time (see utils/scoring/context.ts).
--
-- Before this migration, utils/scoring/score.ts#scoreIcpFit received
-- `client_icp_targets: null` from every ingest path and fell back to the
-- neutral 0.5 branch — which meant ICP fit was effectively dead weight in
-- composite_score. Callers now load this column and pass it to scrubBatch.

alter table public.clients
  add column if not exists icp_targets text[] not null default '{}';

comment on column public.clients.icp_targets is
  'ICP segments this client is hunting, e.g. {salon,b2c_beauty,retailer,influencer}. Used by utils/scoring/score.ts to compute icp_fit_score. Empty array = no filter (scoring stays neutral).';

-- Seed Chella with its four documented target segments from PLAN.md §2.
-- Idempotent: only updates when the array is still empty.
update public.clients
set icp_targets = array['salon','b2c_beauty','retailer','influencer']
where slug = 'chella'
  and (icp_targets is null or cardinality(icp_targets) = 0);
