-- Billing + API key support

-- Stripe identifiers on clients so we can map webhooks back to a tenant
-- and open the customer portal without a detour.
alter table public.clients
  add column if not exists stripe_customer_id     text unique,
  add column if not exists stripe_subscription_id text unique,
  add column if not exists trial_ends_at          timestamptz,
  add column if not exists plan_current_period_end timestamptz;

create index if not exists idx_clients_stripe_customer
  on public.clients (stripe_customer_id);

-- Per-client API keys so Agency/Enterprise customers can hit
-- /api/ingest and /api/push/* server-to-server without leaking our
-- INGEST_SECRET. Keys are stored hashed.
create table if not exists public.api_keys (
  id          uuid primary key default uuid_generate_v4(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  key_hash    text not null unique,          -- sha256 of the raw key
  key_prefix  text not null,                 -- first 10 chars, for UI display
  label       text,
  last_used   timestamptz,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index on public.api_keys (client_id) where revoked_at is null;

-- Webhooks: lets a client POST a URL we'll hit when an export completes
-- or a new batch is scrubbed. Handy for pushing to their own systems.
create table if not exists public.webhooks (
  id          uuid primary key default uuid_generate_v4(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  url         text not null,
  events      text[] not null default '{export.completed,scrub.completed}',
  secret      text not null,    -- HMAC signing secret
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Update v_client_usage to use the centralized cap logic.
-- (If plan column gets out of sync with Stripe, webhook keeps it honest.)
drop view if exists public.v_client_usage;
create or replace view public.v_client_usage as
select
  c.id as client_id,
  c.plan,
  c.stripe_customer_id,
  c.plan_current_period_end,
  count(l.id) filter (where l.created_at >= date_trunc('month', now())) as leads_this_month,
  count(l.id) filter (where l.is_scrubbed and l.created_at >= date_trunc('month', now())) as clean_this_month,
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

-- RLS: a client can only see their own api_keys + webhooks
alter table public.api_keys enable row level security;
alter table public.webhooks enable row level security;

create policy "api_keys: owner read"
  on public.api_keys for select
  using (
    exists (
      select 1 from public.clients c
      where c.id = api_keys.client_id and c.owner_user = auth.uid()
    )
  );

create policy "api_keys: owner write"
  on public.api_keys for all
  using (
    exists (
      select 1 from public.clients c
      where c.id = api_keys.client_id and c.owner_user = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.clients c
      where c.id = api_keys.client_id and c.owner_user = auth.uid()
    )
  );

create policy "webhooks: owner read"
  on public.webhooks for select
  using (
    exists (
      select 1 from public.clients c
      where c.id = webhooks.client_id and c.owner_user = auth.uid()
    )
  );

create policy "webhooks: owner write"
  on public.webhooks for all
  using (
    exists (
      select 1 from public.clients c
      where c.id = webhooks.client_id and c.owner_user = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.clients c
      where c.id = webhooks.client_id and c.owner_user = auth.uid()
    )
  );

-- =========================================================
-- Subscriptions table hardening
-- The webhook upserts by stripe_subscription_id, which needs a unique
-- constraint for ON CONFLICT to work. Also add a direct user_id
-- reference so we can look up by auth user during checkout.completed
-- without round-tripping through clients.
-- =========================================================
alter table public.subscriptions
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'subscriptions_stripe_subscription_id_key'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_stripe_subscription_id_key unique (stripe_subscription_id);
  end if;
end $$;

-- client_id in 0001_init.sql was NOT NULL; relax it since new rows from
-- checkout.session.completed come in before a client row exists, and the
-- webhook stamps the link onto clients separately.
alter table public.subscriptions
  alter column client_id drop not null;

create index if not exists idx_subscriptions_user
  on public.subscriptions (user_id);
