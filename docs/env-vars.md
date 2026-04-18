# Environment Variables

Every variable referenced by the app, grouped by category. The **required** vars are the minimum set to get a green Vercel deploy; everything else is feature-gated.

Keep `.env.example` in sync with this doc. When you add a new env var to code, add it to both.

---

## Required

### Supabase — auth + database
| Var | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | [supabase.com/dashboard](https://supabase.com/dashboard) → Project → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page → `anon` / `public` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` key (⚠ server-only, never expose to browser) |
| `SUPABASE_DB_URL` | Project → Settings → Database → Connection string. CLI-only (for `supabase db push` / psql). Not required on Vercel. |

Sign up: <https://supabase.com/dashboard/sign-up>

### Stripe — billing
| Var | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY` | [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys) → Secret key |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Same page → Publishable key |
| `STRIPE_WEBHOOK_SECRET` | [dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks) → create endpoint `https://<your-domain>/api/stripe/webhook` → reveal signing secret |
| `STRIPE_PRICE_STARTER` | [dashboard.stripe.com/products](https://dashboard.stripe.com/products) → create product → copy price id (`price_...`) |
| `STRIPE_PRICE_GROWTH` | Same — create Growth product |
| `STRIPE_PRICE_AGENCY` | Same — create Agency product |

Sign up: <https://dashboard.stripe.com/register>

### Resend — transactional email
| Var | Where to get it |
|---|---|
| `RESEND_API_KEY` | [resend.com/api-keys](https://resend.com/api-keys) → Create API Key |

Before keys work end-to-end you must also **verify a sending domain** at [resend.com/domains](https://resend.com/domains) — without it, mail lands in spam or is rejected.

Sign up: <https://resend.com/signup>

### App
| Var | Example |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://oneclickitleads.com` |
| `INGEST_SECRET` | Generate with `openssl rand -hex 32` — shared between cron + import jobs |

---

## Optional — Stripe annual plans

Create annual variants of each product in Stripe, then set:

- `STRIPE_PRICE_STARTER_ANNUAL`
- `STRIPE_PRICE_GROWTH_ANNUAL`
- `STRIPE_PRICE_AGENCY_ANNUAL`

Falls back to monthly if unset.

---

## Optional — Contact form overrides

| Var | Default |
|---|---|
| `CONTACT_EMAIL_TO` | `contact@oneclickit.ai` |
| `CONTACT_EMAIL_FROM` | `OneClickitLeads <noreply@oneclickit.ai>` — must be on a Resend-verified domain |

---

## Optional — Email verification vendors

Used by the scrubbing pipeline. You only need one, but more = better consensus scoring.

| Var | Where to get it |
|---|---|
| `NEVERBOUNCE_API_KEY` | [app.neverbounce.com/apps/custom-integration](https://app.neverbounce.com/apps/custom-integration) |
| `ZEROBOUNCE_API_KEY` | [app.zerobounce.net/members/apikey](https://app.zerobounce.net/members/apikey) |
| `HUNTER_API_KEY` | [hunter.io/api-keys](https://hunter.io/api-keys) |
| `SNOV_CLIENT_ID` | [app.snov.io/account/api](https://app.snov.io/account/api) |
| `SNOV_CLIENT_SECRET` | Same page — shown once on creation, store it immediately |

Sign-up pages: [NeverBounce](https://app.neverbounce.com/sign-up) · [ZeroBounce](https://www.zerobounce.net/members/register/) · [Hunter.io](https://hunter.io/users/sign_up) · [Snov.io](https://app.snov.io/register)

---

## Optional — Data source APIs

| Var | Where to get it |
|---|---|
| `APOLLO_API_KEY` | [app.apollo.io/#/settings/integrations/api](https://app.apollo.io/#/settings/integrations/api) |
| `COMMONROOM_API_KEY` | [app.commonroom.io](https://app.commonroom.io/) → Settings → API |
| `SCRAPINGBEE_API_KEY` | [app.scrapingbee.com/account](https://app.scrapingbee.com/account) |
| `BRIGHTDATA_API_KEY` | [brightdata.com/cp/api_tokens](https://brightdata.com/cp/api_tokens) |
| `GOOGLE_PLACES_KEY` | [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) — create key, enable the **Places API (New)** product (not just legacy Places) |

Sign-up pages: [Apollo](https://app.apollo.io/#/login) · [Common Room](https://www.commonroom.io/sign-up/) · [ScrapingBee](https://app.scrapingbee.com/account/register) · [Bright Data](https://brightdata.com/) · [Google Cloud](https://console.cloud.google.com/)

`/api/scrape-osm` uses OpenStreetMap Overpass — no key required.

---

## Optional — Destinations

### Smartly.io (ad custom audiences)
| Var | Where to get it |
|---|---|
| `SMARTLY_API_TOKEN` | [app.smartly.io](https://app.smartly.io) → Settings → API access (requires agency seat) |
| `SMARTLY_ACCOUNT_ID` | URL of your Smartly dashboard: `app.smartly.io/accounts/<ACCOUNT_ID>/...` |
| `SMARTLY_API_BASE` | Default: `https://api.smartly.io/api/v3` |
| `SMARTLY_AUDIENCE_PATH` | Default: `/custom_audiences` |

Contact: <https://www.smartly.io/contact-us>

### Klaviyo (suppression sync)
| Var | Where to get it |
|---|---|
| `KLAVIYO_API_KEY` | [klaviyo.com](https://www.klaviyo.com/) → Account → Settings → API Keys → Create Private API Key |

Sign up: <https://www.klaviyo.com/sign-up>

### Shopify (future — CSV import works without keys)
Currently commented out; only needed if you move to direct API sync:
- `SHOPIFY_SHOP` — e.g. `chella.myshopify.com`
- `SHOPIFY_ADMIN_TOKEN` — Create a [custom app](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin) in the Shopify Admin

---

## Setting these on Vercel

1. Project → Settings → Environment Variables
2. Paste each `KEY=value` pair for the appropriate environment (Production / Preview / Development).
3. Mark secrets as **Sensitive** so they don't appear in build logs.
4. Trigger a redeploy (env changes don't auto-redeploy existing deployments).

`NEXT_PUBLIC_*` vars must be set at **build time** — after changing them, Vercel needs a fresh build, not just a redeploy.
