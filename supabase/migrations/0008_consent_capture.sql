-- Proof of consent capture
--
-- When someone opts in via /submit-lead we record *who consented, when,
-- from where, to what text*. This is the evidence a compliance reviewer
-- (Meta, TikTok, CCPA auditor) asks for when they see a cold email and
-- want proof the recipient actually opted in.
--
-- Fields map 1:1 to the fields smartly.io / Meta CAPI ask for in their
-- audit forms:
--
--   consent_ts            when the user clicked "I agree"
--   consent_ip            source IP at click-time (inet, not logged in
--                         request logs after 30d — this is the durable copy)
--   consent_ua            user-agent string
--   consent_text_version  which version of the consent text they saw
--   consent_source_url    the page/form URL they consented on
--
-- The companion /proof/[lead_id] route renders a shareable URL that returns
-- these fields for owner-authenticated users only (RLS on leads enforces
-- tenant isolation, so a client only ever sees their own proofs).

alter table public.leads
  add column if not exists consent_ts            timestamptz,
  add column if not exists consent_ip            inet,
  add column if not exists consent_ua            text,
  add column if not exists consent_text_version  text,
  add column if not exists consent_source_url    text;

comment on column public.leads.consent_ts is
  'When the lead clicked the consent checkbox on an opt-in form. Null for leads that arrived via scraping/enrichment — which means they are NOT export-eligible to channels that require proof of consent (Meta/TikTok custom audiences).';

comment on column public.leads.consent_text_version is
  'Version identifier of the consent copy the user saw (e.g. "2026-04-22a"). Bump whenever the marketing-consent language changes so proofs remain attributable to the correct text.';

create index if not exists idx_leads_consent_ts
  on public.leads (client_id, consent_ts desc)
  where consent_ts is not null;
