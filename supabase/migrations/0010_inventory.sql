-- Add is_inventory flag to leads for pre-scraped database
alter table public.leads
  add column if not exists is_inventory boolean not null default false;

create index if not exists leads_inventory_idx
  on public.leads (is_inventory, client_id)
  where is_inventory = true;

comment on column public.leads.is_inventory is
  'True for leads populated by the batch-beauty scraper (shared inventory database). '
  'Starter and Growth plans access leads via this flag rather than running custom scrapes.';
