-- Lead scoring + plan enforcement

-- Composite score = Google rating × ratings_count, normalized.
-- High-signal salons (4.8★ with 500 reviews) float to the top of exports.
alter table public.leads
  add column if not exists lead_quality_score numeric
  generated always as (coalesce(rating, 0) * coalesce(rating_count, 0) / 100.0) stored;

create index if not exists idx_leads_quality
  on public.leads (client_id, lead_quality_score desc)
  where is_scrubbed = true;

-- Plan-based export limits.
-- A view the export API checks before serving a download.
create or replace view public.v_client_usage as
select
  c.id as client_id,
  c.plan,
  count(l.id) filter (where l.created_at >= date_trunc('month', now())) as leads_this_month,
  count(l.id) filter (where l.is_scrubbed and l.created_at >= date_trunc('month', now())) as clean_this_month,
  case c.plan
    when 'starter' then 2500
    when 'growth'  then 15000
    when 'agency'  then 60000
    else 100000000
  end as monthly_cap
from public.clients c
left join public.leads l on l.client_id = c.id
group by c.id, c.plan;
