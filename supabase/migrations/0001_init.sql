-- OneClickitLeads.com — initial schema
-- Run with: supabase db push

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- =========================================================
-- clients (tenants)
-- =========================================================
create table if not exists public.clients (
  id           uuid primary key default uuid_generate_v4(),
  name         text not null,
  slug         text not null unique,        -- e.g. 'chella'
  owner_user   uuid references auth.users(id),
  plan         text not null default 'starter',
  created_at   timestamptz not null default now()
);

-- =========================================================
-- suppressions (per-client blocklist)
-- =========================================================
create table if not exists public.suppressions (
  id           uuid primary key default uuid_generate_v4(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  email        citext,
  phone        text,
  reason       text,   -- 'unsub' | 'bounce' | 'competitor' | 'existing_customer'
  added_at     timestamptz not null default now()
);
create index on public.suppressions (client_id, email);
create index on public.suppressions (client_id, phone);

-- =========================================================
-- sources (audit trail for CCPA)
-- =========================================================
create table if not exists public.sources (
  id           uuid primary key default uuid_generate_v4(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  kind         text not null,      -- 'apollo' | 'commonroom' | 'scraped' | 'purchased' | 'firstparty'
  label        text,               -- human label: "Yelp LA eyebrow-salons 2026-04"
  source_url   text,
  created_at   timestamptz not null default now()
);

-- =========================================================
-- leads
-- =========================================================
create table if not exists public.leads (
  id                 uuid primary key default uuid_generate_v4(),
  client_id          uuid not null references public.clients(id) on delete cascade,
  source_id          uuid references public.sources(id),

  -- core PII
  first_name         text,
  last_name          text,
  email              citext,
  email_hash         text generated always as (encode(digest(lower(coalesce(email,'')), 'sha256'), 'hex')) stored,
  phone_e164         text,

  -- firmographics / enrichment
  company            text,
  title              text,
  linkedin_url       text,
  instagram_handle   text,
  city               text,
  region             text,
  country            text,

  -- ICP tags (beauty-specific)
  icp_segment        text,          -- 'b2c_beauty' | 'salon' | 'retailer' | 'influencer'
  tags               text[] default '{}',

  -- scrubbing state
  is_scrubbed        boolean not null default false,
  syntax_valid       boolean,
  mx_valid           boolean,
  smtp_valid         boolean,
  is_disposable      boolean,
  is_duplicate       boolean,
  is_suppressed      boolean,
  scrub_score        int,           -- 0-100
  reject_reason      text,

  raw                jsonb,         -- original row, for audit
  created_at         timestamptz not null default now(),
  scrubbed_at        timestamptz
);

-- unique email per client (post-normalize)
create unique index if not exists leads_unique_client_email
  on public.leads (client_id, email_hash)
  where email is not null;

create index on public.leads (client_id, is_scrubbed, scrub_score);
create index on public.leads (client_id, icp_segment);

-- =========================================================
-- lead_events (audit)
-- =========================================================
create table if not exists public.lead_events (
  id         uuid primary key default uuid_generate_v4(),
  lead_id    uuid not null references public.leads(id) on delete cascade,
  kind       text not null,    -- 'ingested'|'verified'|'exported'|'unsubscribed'|'bounced'
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- =========================================================
-- exports (reconciliation)
-- =========================================================
create table if not exists public.exports (
  id          uuid primary key default uuid_generate_v4(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  destination text not null,      -- 'smartly' | 'csv' | 'api'
  filters     jsonb,
  row_count   int,
  file_hash   text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

-- =========================================================
-- subscriptions (Stripe)
-- =========================================================
create table if not exists public.subscriptions (
  id                      uuid primary key default uuid_generate_v4(),
  client_id               uuid not null references public.clients(id) on delete cascade,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  tier                    text,
  status                  text,
  current_period_end      timestamptz,
  updated_at              timestamptz not null default now()
);

-- =========================================================
-- Row Level Security
-- =========================================================
alter table public.clients        enable row level security;
alter table public.leads          enable row level security;
alter table public.suppressions   enable row level security;
alter table public.sources        enable row level security;
alter table public.lead_events    enable row level security;
alter table public.exports        enable row level security;
alter table public.subscriptions  enable row level security;

-- a client user can only see rows that belong to a client they own
create policy "clients_owner_read"
  on public.clients for select
  using (owner_user = auth.uid());

create policy "leads_owner_read"
  on public.leads for select
  using (client_id in (select id from public.clients where owner_user = auth.uid()));

create policy "leads_owner_write"
  on public.leads for insert
  with check (client_id in (select id from public.clients where owner_user = auth.uid()));

create policy "suppressions_owner_all"
  on public.suppressions for all
  using (client_id in (select id from public.clients where owner_user = auth.uid()))
  with check (client_id in (select id from public.clients where owner_user = auth.uid()));

create policy "exports_owner_read"
  on public.exports for select
  using (client_id in (select id from public.clients where owner_user = auth.uid()));

-- seed Chella as first client (replace owner_user after first signup)
insert into public.clients (name, slug, plan)
values ('Chella', 'chella', 'growth')
on conflict (slug) do nothing;
