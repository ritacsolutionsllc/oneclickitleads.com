-- ICP targets per client + source trust tier defaults
--
-- Until now the ICP fit sub-score always landed at 0.5 (neutral) because
-- ingestion routes had nowhere to look up the client's target segments.
-- Store them on `clients` as an array so every scrub_batch call can thread
-- them through to scoreLead() without extra plumbing.
--
-- Also document the source kind → trust tier mapping. We already default
-- `sources.trust_tier = 4` in 0005, but first-party imports (Shopify,
-- consent form) need to land at tier 1 and Apollo/CommonRoom at tier 2.

alter table public.clients
  add column if not exists icp_targets text[] not null default
    array['b2c_beauty', 'salon', 'retailer', 'influencer']::text[];

comment on column public.clients.icp_targets is
  'Lead ICP segments this client is actively targeting. Used by the scoring engine to give icp_fit = 1.0 when a lead matches, 0.2 when it does not, and 0.5 when the client has no targets configured.';

-- Backfill the existing Chella row with its known targets.
update public.clients
  set icp_targets = array['b2c_beauty', 'salon', 'retailer', 'influencer']
  where slug = 'chella'
    and (icp_targets is null or cardinality(icp_targets) = 0);
