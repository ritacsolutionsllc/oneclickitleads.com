-- Google Places support — ratings and indexes for dedupe
alter table public.leads add column if not exists rating numeric;
alter table public.leads add column if not exists rating_count integer;
alter table public.leads add column if not exists website text;

create index if not exists idx_leads_phone on public.leads (client_id, phone_e164);
create index if not exists idx_leads_website on public.leads (client_id, website);

-- cron extension (one-time)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Daily 9am PT salon crawl for Chella across the top CA metros.
-- Adjust cities as Chella's campaigns evolve.
select cron.schedule(
  'chella-ca-salons-daily',
  '0 16 * * *',  -- 16:00 UTC = 9am Pacific
  $$
    select net.http_get(url := 'https://oneclickitleads.com/api/places-salons?client=chella&query=' || urlencode(q))
    from (values
      ('eyebrow salon Los Angeles CA'),
      ('lash studio Los Angeles CA'),
      ('beauty salon San Diego CA'),
      ('beauty salon San Francisco CA'),
      ('brow bar Orange County CA'),
      ('makeup studio Sacramento CA'),
      ('eyebrow salon San Jose CA')
    ) as t(q);
  $$
);
