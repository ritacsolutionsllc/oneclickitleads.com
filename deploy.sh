#!/usr/bin/env bash
# OneClickitLeads.com — one-shot deploy script
# Prereqs: node 18+, supabase CLI, vercel CLI, a Supabase project, a Vercel account
set -euo pipefail

say() { printf "\n\033[1;32m▶ %s\033[0m\n" "$*"; }

say "1/6  Install dependencies"
npm install

say "2/6  Push Supabase schema"
# requires: supabase login && supabase link --project-ref <your-ref>
supabase db push

say "3/6  Deploy edge function"
supabase functions deploy scrub-leads

say "4/6  Seed Chella as first client (idempotent)"
supabase db execute --sql "
  insert into public.clients (name, slug, plan)
  values ('Chella', 'chella', 'growth')
  on conflict (slug) do nothing;
"

say "5/6  Set Vercel env vars (interactive if not already set)"
for k in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY \
         SUPABASE_SERVICE_ROLE_KEY GOOGLE_PLACES_KEY \
         NEVERBOUNCE_API_KEY HUNTER_API_KEY APOLLO_API_KEY \
         STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET \
         SMARTLY_API_TOKEN SMARTLY_ACCOUNT_ID INGEST_SECRET; do
  vercel env ls production | grep -q "^$k" || vercel env add "$k" production
done

say "6/6  Deploy to Vercel"
vercel --prod

cat <<EOM

✅  Done.

Next steps:
  1. vercel domains add oneclickitleads.com
  2. Point DNS A record @ → 76.76.21.21  (or Vercel's CNAME target)
  3. Test scraper:
       curl -s "https://oneclickitleads.com/api/places-salons?client=chella&query=eyebrow+salon+Gardena+CA" | jq
  4. Log in at /dashboard and export your first CSV.
EOM
