-- Migration 0009: scrape_runs table for persistent scrape history
--
-- Stores the result of every scrape/harvest/enrich/rescrub operation so
-- users can see what ran, when, and how many leads were affected — even
-- after navigating away from the Scrape page.

create table if not exists public.scrape_runs (
  id           uuid primary key default uuid_generate_v4(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  source       text not null,        -- 'osm' | 'places' | 'harvest' | 'enrich' | 'rescrub'
  params       jsonb,                -- query/city/shop/limit etc.
  result       jsonb,                -- inserted/skipped/errors/processed/clean etc.
  status       text not null default 'ok',  -- 'ok' | 'error'
  error_msg    text,
  created_at   timestamptz not null default now()
);

create index on public.scrape_runs (client_id, created_at desc);

-- RLS: users can only see their own clients' runs
alter table public.scrape_runs enable row level security;

create policy "scrape_runs_owner_select"
  on public.scrape_runs for select
  using (
    client_id in (
      select id from public.clients where owner_user = auth.uid()
    )
  );

-- Inserts happen via the admin client (server-side only), no user INSERT policy needed.
