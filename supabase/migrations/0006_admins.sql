-- Platform super-admins.
--
-- A super-admin is a Supabase auth user whose JWT has
--   app_metadata: { is_admin: true }
-- They see + act on every tenant's data. Use sparingly — this is meant
-- for the Ritac Solutions operators and whitelisted customer champions,
-- not a generic "team member" role.
--
-- To grant / revoke after a user has signed up at least once:
--   update auth.users
--     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
--                              || '{"is_admin": true}'::jsonb
--     where email = 'chris@chella.com';
--
--   update auth.users
--     set raw_app_meta_data = raw_app_meta_data - 'is_admin'
--     where email = 'chris@chella.com';
--
-- Users must sign out + back in (or wait for the session to refresh) for
-- the claim to propagate to their JWT.

create or replace function public.is_platform_admin()
  returns boolean
  language sql
  stable
  as $$
    select coalesce(
      (auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean,
      false
    );
  $$;

-- Admin policies: added alongside the existing owner policies. Postgres
-- OR's multiple permissive policies for the same action, so owners keep
-- their scoped access and admins layer on top.
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'clients_admin_all') then
    create policy "clients_admin_all" on public.clients
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'leads_admin_all') then
    create policy "leads_admin_all" on public.leads
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'suppressions_admin_all') then
    create policy "suppressions_admin_all" on public.suppressions
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'sources_admin_all') then
    create policy "sources_admin_all" on public.sources
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'lead_events_admin_all') then
    create policy "lead_events_admin_all" on public.lead_events
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'exports_admin_all') then
    create policy "exports_admin_all" on public.exports
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'subscriptions_admin_all') then
    create policy "subscriptions_admin_all" on public.subscriptions
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'api_keys_admin_all') then
    create policy "api_keys_admin_all" on public.api_keys
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'webhooks_admin_all') then
    create policy "webhooks_admin_all" on public.webhooks
      for all using (public.is_platform_admin())
      with check (public.is_platform_admin());
  end if;
end $$;
