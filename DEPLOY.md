# Deploying OneClickitLeads to Vercel

End-to-end runbook for going from this folder → `oneclickitleads.com` live on Vercel with Git-based CI/CD.

Run everything from **your own terminal** (macOS Terminal / Windows PowerShell), not from inside Cowork. Cowork's sandbox can't manage the `.git` directory because of mount permissions.

---

## Prerequisites

- Node 20+ installed locally (`node --version`)
- `git` installed (`git --version`)
- A GitHub account with SSH or HTTPS push access
- Vercel CLI (optional but handy): `npm i -g vercel`
- Stripe CLI (for local webhook testing): https://stripe.com/docs/stripe-cli

---

## Step 1 — Clean up sandbox leftovers

When I tried to set up git from the Cowork sandbox it left two stubs behind that the sandbox can't remove (the mount blocks file deletion for safety). Wipe them from your own terminal first:

```bash
cd "/path/to/Chella lead generation/OneClickitLeads"
rm -rf .git
rm -f test-delete.txt
```

On Windows:
```powershell
Remove-Item .git -Recurse -Force
Remove-Item test-delete.txt -ErrorAction SilentlyContinue
```

---

## Step 2 — Initialize the repo and first commit

```bash
cd "/path/to/Chella lead generation/OneClickitLeads"

git init -b main
git config user.email "ritacsolutions@gmail.com"
git config user.name "Keaton"

# Sanity check — .env.local MUST be in gitignore before we add anything
grep "^\.env\.local$" .gitignore || echo "WARNING: .env.local not ignored — stop and fix"

git add -A
git status | grep -i "env\.local" && echo "STOP — secret file is staged" || echo "ok — no env.local staged"

git commit -m "Initial commit: OneClickitLeads SaaS scaffold

- Next.js 14 App Router + TypeScript + Tailwind
- Supabase auth + Postgres + RLS (4 migrations)
- Stripe subscriptions (Starter/Growth/Agency, monthly + annual)
- Client dashboard (leads, suppressions, exports, billing, settings)
- Lead scrubbing pipeline (dedup, email/phone validation, suppression)
- Shopify CSV import, Klaviyo sync, smartly.io push routes"
```

---

## Step 3 — Push to GitHub

Repo: **https://github.com/OneClickIT-ai/oneclickitleads.com**

```bash
# HTTPS (simplest)
git remote add origin https://github.com/OneClickIT-ai/oneclickitleads.com.git
git push -u origin main

# OR SSH (if you have SSH keys set up for OneClickIT-ai org)
git remote add origin git@github.com:OneClickIT-ai/oneclickitleads.com.git
git push -u origin main
```

If `git push` asks for credentials on HTTPS, use a [personal access token](https://github.com/settings/tokens) (classic, `repo` scope) as the password — GitHub stopped accepting account passwords for git operations in 2021.

---

## Step 4 — Import into Vercel

1. Go to https://vercel.com/new
2. Team: **ritacsolutionsllc's projects**
3. Click **Import** next to the new `oneclickitleads` repo
4. Project name: `oneclickitleads`
5. Framework preset: **Next.js** (auto-detected)
6. Root directory: `./` (the repo root IS the Next.js app)
7. Build command / output dir: leave defaults

**Before clicking Deploy — expand "Environment Variables" and paste these:**

| Variable | Scope | Value source |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All | from `.env.local` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | All | from `.env.local` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | All | from `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | Production, Preview | from `.env.local` (JWT starting `eyJ...`) |
| `SUPABASE_DB_URL` | Production | from `.env.local` (pooler URL) |
| `STRIPE_SECRET_KEY` | Production | `sk_live_...` from Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | Production | filled in Step 6 below |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | All | `pk_live_...` |
| `STRIPE_PRICE_STARTER` | All | `price_1TNJyuGjV1Qo4p4LMoFxTekw` |
| `STRIPE_PRICE_STARTER_ANNUAL` | All | `price_1TNJyvGjV1Qo4p4LzKiDPJfw` |
| `STRIPE_PRICE_GROWTH` | All | `price_1TNJywGjV1Qo4p4LHljjJeQr` |
| `STRIPE_PRICE_GROWTH_ANNUAL` | All | `price_1TNJyxGjV1Qo4p4LBR3452om` |
| `STRIPE_PRICE_AGENCY` | All | `price_1TNJyyGjV1Qo4p4LcBAPwO4i` |
| `STRIPE_PRICE_AGENCY_ANNUAL` | All | `price_1TNJyzGjV1Qo4p4LX43pUbLJ` |
| `INGEST_SECRET` | Production | the 52-char value in `.env.local` |
| `NEXT_PUBLIC_APP_URL` | Production | `https://oneclickitleads.com` |
| `NEXT_PUBLIC_APP_URL` | Preview | `https://$VERCEL_URL` (or omit — Next reads it) |

Leave the optional enrichment/email-verification keys blank for now (`NEVERBOUNCE_API_KEY`, `APOLLO_API_KEY`, etc.) — they degrade gracefully.

Click **Deploy**. First build runs; you'll get a `oneclickitleads-xxxx.vercel.app` URL.

---

## Step 5 — Attach the custom domain

In the Vercel project → **Settings → Domains**:
1. Add `oneclickitleads.com`
2. Add `www.oneclickitleads.com` (redirects to apex)
3. Vercel will show DNS records to set at your registrar (A record `76.76.21.21` for apex, CNAME `cname.vercel-dns.com` for www)
4. Propagation is usually <5 min

---

## Step 6 — Create the Stripe live webhook endpoint

You need this AFTER Vercel gives you a URL, because the endpoint path has to match production.

1. Stripe dashboard → **Developers → Webhooks → Add endpoint**
2. Endpoint URL: `https://oneclickitleads.com/api/stripe/webhook`
3. Events to send:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Click **Add endpoint**
5. Copy the **Signing secret** (`whsec_...`)
6. Back in Vercel → Project Settings → Environment Variables: update `STRIPE_WEBHOOK_SECRET` to the `whsec_...` value
7. **Redeploy** (Vercel → Deployments → latest → ⋯ → Redeploy) so the new env is picked up

---

## Step 7 — Smoke-test production

```bash
# Replace with your live domain
curl -I https://oneclickitleads.com
# Should be 200

curl https://oneclickitleads.com/api/health 2>/dev/null
# If you added one — otherwise hit the pricing page
```

Then manually:
1. Visit `https://oneclickitleads.com/pricing` → click Subscribe (Starter)
2. Auth sign-up flow
3. Stripe Checkout in live mode with a real card (charge $49 — refund after)
4. Webhook fires → check Stripe → Events → should see `checkout.session.completed` with 200
5. Check Supabase `subscriptions` table — new row should exist

---

## Step 8 — Ongoing: every push auto-deploys

From now on:
```bash
git add -A
git commit -m "whatever"
git push
```
Vercel builds and deploys `main` → production. Non-`main` branches get preview URLs automatically.

Database migrations (`supabase/migrations/000X_*.sql`) are NOT auto-applied. When you add a new one, apply it via `supabase db push` locally against `SUPABASE_DB_URL`.

---

## Troubleshooting

**Build fails with "Module not found: stripe"** — run `npm install` locally, commit the lockfile.

**Build succeeds but `/api/stripe/*` routes 500** — env var missing or mistyped in Vercel. Check the function logs in Vercel → Project → Functions.

**Webhook returns 400 "No signature matches expected signature"** — `STRIPE_WEBHOOK_SECRET` in Vercel doesn't match the one Stripe shows in dashboard. Copy again, redeploy.

**Subscription created in Stripe but no row in Supabase** — check `clients` table has a row with the matching `stripe_customer_id`. The webhook upserts by customer ID; orphaned rows indicate the signup flow didn't create the tenant row before checkout.

**RLS policy blocks a query** — switch that route to `createAdminClient()` if it's server-only, or verify the user's `auth.uid()` owns the `clients` row.
