-- RLS gap closures found during the deeper audit
--
-- 1. exports INSERT: /api/export uses the user-scoped client and writes the
--    audit row. Without this policy every CSV download errors with
--    "new row violates row-level security policy for table \"exports\"".
-- 2. v_client_quality: the view was created in 0005 without
--    security_invoker=true, so when a dashboard user queries it the planner
--    uses the view-creator's privileges and bypasses the leads RLS
--    policies — leaking cross-tenant counts. `security_invoker` was added
--    in PG 15 and Supabase runs 15+.
-- 3. sources / lead_events / subscriptions had RLS enabled in 0001 but no
--    policies at all, meaning *no* user-scoped read works. They're currently
--    only touched through admin clients (webhooks, ingest), so this isn't
--    a production 500 yet, but the dashboard quality and audit UIs on the
--    roadmap need these reads. Add owner SELECT policies so those features
--    can ship without another migration.

-- =========================================================
-- exports: owner INSERT + harden to created_by = self
-- =========================================================
drop policy if exists "exports_owner_insert" on public.exports;
create policy "exports_owner_insert"
  on public.exports for insert
  with check (
    client_id in (select id from public.clients where owner_user = auth.uid())
    and (created_by is null or created_by = auth.uid())
  );

-- =========================================================
-- sources: owner SELECT
-- Writes happen from admin client only, so no INSERT policy needed.
-- =========================================================
drop policy if exists "sources_owner_read" on public.sources;
create policy "sources_owner_read"
  on public.sources for select
  using (client_id in (select id from public.clients where owner_user = auth.uid()));

-- =========================================================
-- lead_events: owner SELECT via the parent lead's client
-- =========================================================
drop policy if exists "lead_events_owner_read" on public.lead_events;
create policy "lead_events_owner_read"
  on public.lead_events for select
  using (
    exists (
      select 1
      from public.leads l
      join public.clients c on c.id = l.client_id
      where l.id = lead_events.lead_id
        and c.owner_user = auth.uid()
    )
  );

-- =========================================================
-- subscriptions: owner SELECT
-- user_id was added in 0004 — use it directly (no clients hop required,
-- checkout.session.completed can land before the client row is linked).
-- =========================================================
drop policy if exists "subscriptions_owner_read" on public.subscriptions;
create policy "subscriptions_owner_read"
  on public.subscriptions for select
  using (
    user_id = auth.uid()
    or client_id in (select id from public.clients where owner_user = auth.uid())
  );

-- =========================================================
-- v_client_quality: run under the caller's privileges so leads RLS applies
-- =========================================================
alter view public.v_client_quality set (security_invoker = true);

-- =========================================================
-- Backfill export_policy for any clients created before 0005 ran
-- (defensive — `add column ... default ...` should have backfilled, but
-- some Supabase deploys skip NOT NULL checks on existing rows if the
-- default was later relaxed. This guarantees /api/export doesn't see
-- NULL and fall through to zero allowed tiers.)
-- =========================================================
update public.clients
set export_policy = jsonb_build_object(
  'premium',     'allow',
  'standard',    'allow',
  'prospecting', 'allow',
  'review',      'manual',
  'hold',        'block',
  'discard',     'block',
  'min_composite_score', 50
)
where export_policy is null;
