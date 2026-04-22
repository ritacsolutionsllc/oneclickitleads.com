-- Link Chris at Chella to the Chella client row.
--
-- 0001_init.sql seeded the Chella client with `owner_user = NULL` and
-- the comment said "replace owner_user after first signup" — which never
-- happened. Consequence: chris@chella.com logs in via magic link, the
-- dashboard queries `clients where owner_user = auth.uid()` via RLS,
-- gets zero rows, and drops him onto "Create your first client". He
-- can't see any of the leads, suppressions, or export tools that are
-- supposed to be his.
--
-- This migration does two things:
--
--   1. One-shot: if an auth.users row already exists for chris@chella.com
--      and Chella still has no owner, attach him. Safe to re-run — it
--      no-ops if either condition is false.
--
--   2. Trigger: whenever a new user signs up with an @chella.com email
--      and Chella is still unowned, auto-claim Chella for them. This
--      removes the race between "deploy migration" and "Chris clicks the
--      magic link" — and it means any future Chella teammate we invite
--      lands on an already-linked dashboard.
--
-- The trigger only claims Chella when owner_user IS NULL, so it never
-- overrides an already-attached owner, and never silently moves a client
-- between users.

-- =========================================================
-- 1. One-shot backfill
-- =========================================================
update public.clients
set owner_user = u.id
from auth.users u
where public.clients.slug = 'chella'
  and public.clients.owner_user is null
  and lower(u.email) = 'chris@chella.com';

-- =========================================================
-- 2. Auto-claim trigger
-- =========================================================
create or replace function public.claim_chella_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is not null
     and lower(new.email) like '%@chella.com'
  then
    update public.clients
    set owner_user = new.id
    where slug = 'chella'
      and owner_user is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_claim_chella_on_signup on auth.users;
create trigger trg_claim_chella_on_signup
  after insert on auth.users
  for each row
  execute function public.claim_chella_on_signup();

comment on function public.claim_chella_on_signup() is
  'Auto-assigns the Chella client to any new @chella.com signup when Chella is still unowned. Idempotent: updates nothing if Chella already has an owner.';
