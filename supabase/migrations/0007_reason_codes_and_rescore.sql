-- Quality-first: explainability + rescore bookkeeping
--
-- Adds two columns that make every tier assignment auditable and every
-- re-run of the scoring helper observable:
--
--   reason_codes       text[]       why the lead landed in its current tier
--   last_rescored_at   timestamptz  when the scoring helper last ran
--
-- Existing rows get empty arrays and null timestamps; the scrub pipeline
-- and the rescore helper write both on every update. The UI uses
-- reason_codes to render a human-readable explanation next to each lead,
-- and to filter the review queue by reason (e.g., "show me everything
-- blocked only by missing_phone so I can enrich them").

alter table public.leads
  add column if not exists reason_codes     text[] not null default '{}',
  add column if not exists last_rescored_at timestamptz;

comment on column public.leads.reason_codes is
  'Short identifier codes emitted by the scoring engine (e.g. syntax_invalid, outside_icp, stale_verification, no_phone). Array order is stable per run; UI groups by prefix.';

comment on column public.leads.last_rescored_at is
  'When utils/scoring/rescore.ts last recomputed sub-scores/export_tier for this row. Null for leads inserted before 0007. Bumped on every enrichment/harvest update so stale rescore runs are visible.';

create index if not exists idx_leads_reason_codes
  on public.leads using gin (reason_codes)
  where is_scrubbed = true;

create index if not exists idx_leads_rescored
  on public.leads (client_id, last_rescored_at desc nulls last)
  where is_scrubbed = true;
