-- Migration 0008: admin user tier override
--
-- Stamps all clients owned by admin email addresses with the 'agency' plan
-- so DB-level views (v_client_usage, monthly caps) reflect their elevated access.
-- Runtime enforcement is handled by utils/admin.ts via ADMIN_EMAILS env var.
--
-- To add more admins, re-run this query pattern in the SQL editor:
--   UPDATE public.clients
--   SET plan = 'agency'
--   WHERE owner_user IN (
--     SELECT id FROM auth.users WHERE email = 'newadmin@example.com'
--   );

UPDATE public.clients
SET plan = 'agency'
WHERE owner_user IN (
  SELECT id
  FROM auth.users
  WHERE lower(email) IN (
    'chris@chella.com',
    'ritacsolutions@gmail.com'
  )
);
