-- 0011_disable_unsafe_direct_places_cron.sql
-- The old search_locations cron called /api/places-salons directly without
-- x-ingest-secret. That route is now locked behind the dashboard proxy or
-- trusted server jobs. Remove/disable any unsafe direct cron schedule.

-- Safe no-op if pg_cron is not installed or the job does not exist.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('chella-ca-salons-daily');
  end if;
exception when others then
  -- Ignore if cron schema/job is unavailable in this environment.
  null;
end $$;

comment on table public.sources is
  'Lead source audit trail. Direct browser/API collection must be auth-gated; source rows should include label/source_url and caller routes must capture permission_basis in lead raw metadata.';
