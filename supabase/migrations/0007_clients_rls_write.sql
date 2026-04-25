-- Migration 0007: add missing INSERT and UPDATE/DELETE policies on clients table
--
-- 0001_init.sql only created a SELECT policy. Without INSERT/UPDATE/DELETE
-- policies, authenticated users cannot create or manage their own clients
-- through the user-scoped Supabase client.

-- Allow a user to insert a client they own
create policy "clients_owner_insert"
  on public.clients for insert
  with check (owner_user = auth.uid());

-- Allow a user to update their own clients (name, plan metadata, etc.)
create policy "clients_owner_update"
  on public.clients for update
  using (owner_user = auth.uid())
  with check (owner_user = auth.uid());

-- Allow a user to delete their own clients
create policy "clients_owner_delete"
  on public.clients for delete
  using (owner_user = auth.uid());
