# OneClickitLeads.com

Lead-gen platform: gather → scrub → export. Flagship client: **Chella** (vegan clean beauty). Output destination: **smartly.io**.

## Stack
Next.js 14 (App Router, TS) · Supabase (Postgres + Auth + Edge Functions + RLS) · Vercel · Stripe · Google Places · Hunter.io · NeverBounce · ScrapingBee (optional).

## Repo layout

```
app/
  page.tsx                      ← public landing (uses <PricingGrid />)
  pricing/page.tsx              ← standalone pricing + FAQ
  submit-lead/                  ← public consent-gated form (?client=slug)
  dashboard/
    layout.tsx                  ← auth-gated shell (nav + client switcher)
    page.tsx                    ← overview (stats, usage meter, recent exports)
    leads/page.tsx              ← searchable lead table + smartly.io push
    suppressions/page.tsx       ← suppression manager + bulk paste
    exports/page.tsx            ← full export audit trail
    billing/page.tsx            ← plan status, portal, plan switcher
    settings/page.tsx           ← api keys, webhooks, danger zone
  api/
    ingest/                     ← POST bulk rows (server-to-server)
    places-salons/              ← GET Google Places → scrub → insert
    enrich/                     ← POST Hunter.io domain-search enrichment
    export/                     ← GET CSV or smartly.io JSON (plan-capped)
    import/shopify/             ← POST customers.csv → suppressions + seed
    import/klaviyo/             ← POST sync unsubs/bounces → suppressions
    push/smartly/               ← POST hashed audience to smartly.io
    stripe/
      checkout/                 ← POST create Checkout Session (monthly/annual)
      portal/                   ← POST open customer billing portal
      webhook/                  ← Stripe events → subscriptions + clients.plan
    dashboard/
      clients/                  ← POST create tenant
      clients/delete/           ← POST delete tenant
      suppressions/             ← POST/DELETE per-client suppressions
      api-keys/                 ← POST/DELETE one-time-reveal API keys
      webhooks/                 ← POST/DELETE per-client webhooks
      push-smartly/             ← proxy to /api/push/smartly (owner-verified)
components/
  PricingGrid.tsx               ← monthly/annual toggle + subscribe buttons
  SubscribeButton.tsx           ← hits /api/stripe/checkout
  PortalButton.tsx              ← hits /api/stripe/portal
  DashboardNav.tsx              ← sidebar (overview/leads/…/settings)
  ClientSwitcher.tsx            ← ?client=slug switcher + create-client inline
  SignOutButton.tsx             ← supabase browser sign-out
  SuppressionManager.tsx        ← bulk paste + per-row delete
  ApiKeyManager.tsx             ← generate/reveal-once/revoke
  WebhookManager.tsx            ← url + events + secret issue
  PushToSmartlyForm.tsx         ← segment/min_score/audience_name form
lib/
  plans.ts                      ← single source of truth: tiers, caps, features
supabase/
  migrations/
    0001_init.sql               ← clients, leads, suppressions, exports + RLS
    0002_google_places.sql      ← rating cols, indexes, pg_cron schedule
    0004_billing.sql            ← stripe fields, api_keys, webhooks, usage view
  functions/scrub-leads/        ← nightly re-verify edge function (Deno)
utils/
  supabase/server.ts            ← SSR + admin clients
  scrub/                        ← email / phone / enrich / pipeline
  plans/enforce.ts              ← enforceExport() + maxRowsForExport()
scripts/
  scrub_cli.py                  ← offline bulk scrubber (for purchased lists)
  sample_leads.csv              ← demo input
PLAN.md                         ← full plan, pricing, GTM, compliance
deploy.sh                       ← one-shot deploy
```

## Pricing & plans

Defined centrally in [`lib/plans.ts`](lib/plans.ts); enforced in
[`utils/plans/enforce.ts`](utils/plans/enforce.ts) via the `v_client_usage` view.

| Plan | Monthly | Annual/mo | Clean leads / mo | ICP segments | API | First-party sync |
|---|---|---|---|---|---|---|
| Starter | $49 | $39 | 2,500 | 1 | ❌ | ❌ |
| Growth | $199 | $159 | 15,000 | 4 | ✅ | ✅ |
| Agency | $499 | $399 | 60,000 | unlimited | ✅ | ✅ |
| Enterprise | sales | sales | custom | unlimited | ✅ | ✅ |

All paid plans include a **14-day trial** (`subscription_data.trial_period_days` on checkout).
Stripe price IDs live in `.env.example` under `STRIPE_PRICE_<TIER>` and `STRIPE_PRICE_<TIER>_ANNUAL`.

## Quick start

```bash
cp .env.example .env.local   # fill in Supabase + API keys
npm install
npm run dev                  # → http://localhost:3000
```

Separately:
```bash
supabase login
supabase link --project-ref <your-ref>
supabase db push             # applies 0001 + 0002
supabase functions deploy scrub-leads
```

## Production deploy

```bash
./deploy.sh                  # runs the full pipeline
vercel domains add oneclickitleads.com
```

## The scrubbing pipeline (in order)

1. **Syntax** — RFC 5322 regex
2. **Disposable domain** — blocklist
3. **Suppression** — per-client `suppressions` table
4. **Dedupe** — sha256 hash of normalized email
5. **MX** — DNS lookup
6. **SMTP** — NeverBounce or ZeroBounce (paid APIs)
7. **Enrichment** — Hunter.io + Apollo (non-blocking, parallel)

A lead is `is_scrubbed = true` only if it clears 1–5 (SMTP is “bonus score,” not a hard gate when no verifier is configured). Rejected leads stay in the DB with `reject_reason` so we can audit and refund any bounces.

## Data sources (priority order)

1. **Apollo / Common Room** — B2B, already wired
2. **Google Places** — CA salons / lash studios / brow bars (primary B2B scraper, best free tier)
3. **Hunter.io / Snov.io** — email-finder for inbound domains from Places/scraping
4. **ScrapingBee** — Instagram bios for influencers, directory sites Google doesn’t cover
5. **Purchased lists** — run through `scripts/scrub_cli.py` before inserting
6. **First-party** — Chella’s Shopify/Klaviyo data (suppression + lookalike seed)

## First-party sync (once Chella hands over credentials)

```bash
# Shopify customers → suppression + lookalike seed in one shot
curl -sX POST https://oneclickitleads.com/api/import/shopify \
  -F "file=@chella-customers.csv" \
  -F "client_slug=chella" \
  -F "mode=both"

# Klaviyo unsubs/bounces/spam → suppressions (idempotent — run nightly via pg_cron)
curl -sX POST https://oneclickitleads.com/api/import/klaviyo \
  -H "x-ingest-secret: $INGEST_SECRET" \
  -H "content-type: application/json" \
  -d '{"client_slug":"chella","kinds":["unsubscribed","bounced","spam"]}'

# Push scrubbed leads to smartly.io as a Custom Audience
curl -sX POST https://oneclickitleads.com/api/push/smartly \
  -H "x-ingest-secret: $INGEST_SECRET" \
  -H "content-type: application/json" \
  -d '{"client_slug":"chella","segment":"salon","min_score":60}'
```

## Offline bulk scrubber (for purchased lists)

```bash
pip install phonenumbers dnspython requests
python scripts/scrub_cli.py \
  --input scripts/sample_leads.csv \
  --output clean.csv \
  --rejects rejects.csv \
  --suppressions scripts/sample_suppressions.csv \
  --report report.json
```

## Compliance

- `/privacy` + `/data-request` pages mandatory before public traffic
- every row stores `source_id` → `sources.source_url` for CCPA audit
- unsub webhook (smartly.io → `/api/unsub`) auto-inserts into `suppressions`
- no cold outreach from scraped-only sources without opt-in signal

## Costs (month 1 target: ≤ $300)

| Item | Cost |
|---|---|
| Vercel Pro | $20 |
| Supabase Pro | $25 |
| Hunter.io Starter | $49 |
| NeverBounce PAYG | ~$30 |
| ScrapingBee Starter | $49 |
| Google Places | $0 (free credit covers ~40k calls) |
| **Total** | **~$173/mo** |

Push to ~$500/mo once scraping scales; breakeven against 1 Growth-tier paying client.
