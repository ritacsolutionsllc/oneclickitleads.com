-- 0010_api_ingestion_hardening.sql
-- Production hardening for compliant API ingestion + import idempotency.

-- Shopify suppression imports upsert by (client_id,email). This constraint keeps
-- repeated first-party customer imports idempotent without creating duplicates.
create unique index if not exists suppressions_unique_client_email
  on public.suppressions (client_id, email)
  where email is not null;

-- Phone-only suppressions are also idempotent.
create unique index if not exists suppressions_unique_client_phone
  on public.suppressions (client_id, phone)
  where phone is not null;

-- Make common lead lookup/filter paths explicit for dashboard/API performance.
create index if not exists leads_client_created_at_idx
  on public.leads (client_id, created_at desc);

create index if not exists leads_client_company_idx
  on public.leads (client_id, company)
  where company is not null;

create index if not exists leads_client_city_region_idx
  on public.leads (client_id, city, region)
  where city is not null;

-- API key lookup already has unique key_hash. Add active-key lookup helper.
create index if not exists api_keys_active_client_idx
  on public.api_keys (client_id, created_at desc)
  where revoked_at is null;
