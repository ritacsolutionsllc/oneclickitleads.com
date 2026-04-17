# OneClickitLeads.com — Platform Plan

**Owner:** Keaton | Ritac Solutions
**Flagship client:** Chella.com (vegan clean beauty — brow pencils, eyeliners, mascaras)
**Output destination:** smartly.io (paid media activation)
**Stack:** Next.js (App Router, TS) + Supabase (Postgres/Auth/Edge Functions) + Vercel + Stripe
**Budget Phase 1:** $100–$300/mo APIs; scale to $500–$1,500/mo at volume

---

## 1. Why this platform exists

Chella currently uses smartleads.io but isn't getting lead quality that performs in smartly.io. OneClickitLeads.com solves that by owning the full pipeline:

1. **Source** — Apollo, Common Room, purchased lists, ethical scraping (Yelp/Google Maps/Instagram bios)
2. **Scrub** — syntax + MX + SMTP validation, dedupe, enrichment, suppression filtering
3. **Segment** — client-specific ICP filters (Chella: eco-conscious female 25–54, salons, retailers, influencers)
4. **Export** — clean CSV/JSON or direct Custom Audience push to smartly.io
5. **Bill** — Stripe tiered SaaS ($49–$499/mo) so the same platform generates revenue from future clients (not just Chella)

---

## 2. Target ICPs for Chella

| Segment | Who | Where to find | Primary signal |
|---|---|---|---|
| **B2C — eco beauty buyer** | Women 25–54, interest in clean/vegan cosmetics | Instagram bios, Sephora/Ulta review scrapes, lookalike seeds from Chella's own CRM | Mentions of "clean beauty", "vegan", "cruelty-free"; follows competitors (ILIA, Kosas, RMS) |
| **B2B — salon/spa owners** | Brow bars, lash studios, full-service spas | Yelp, Google Maps, IBS/Cosmoprof attendee lists | Business category + verified contact email |
| **B2B — indie retailers** | Boutique beauty retailers, eco/health stores | Faire, Bulletin, local chamber directories | Stocks vegan/clean brands |
| **B2B — beauty influencers/MUA** | Micro (10k–100k) + mid (100k–500k) beauty creators | Instagram/TikTok scrape, Modash, HypeAuditor | Niche tags: #cleanbeauty, #browgoals, #veganmakeup |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      OneClickitLeads.com (Vercel)                   │
│                                                                     │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐        │
│  │ Marketing/    │    │ Client        │    │ Admin         │        │
│  │ Landing (/)   │    │ Dashboard     │    │ Console       │        │
│  └───────┬───────┘    └───────┬───────┘    └───────┬───────┘        │
│          │                    │                    │                │
│  ┌───────▼────────────────────▼────────────────────▼───────┐        │
│  │              Next.js App Router API Routes              │        │
│  │  /api/ingest  /api/scrape  /api/verify  /api/export     │        │
│  └───────┬─────────────────────────────────────────────────┘        │
└──────────┼──────────────────────────────────────────────────────────┘
           │
   ┌───────▼─────────────────────────────────────────────┐
   │                    Supabase                         │
   │   Postgres (leads, clients, suppressions, jobs)     │
   │   Auth (clients + operators)                        │
   │   Edge Functions (scrub-leads, nightly-reverify)    │
   │   Storage (CSV uploads / exports)                   │
   │   RLS policies (client_id = auth.uid())             │
   └────────┬────────────────────────────────────────────┘
            │
   ┌────────┴──────────────────────────────────────────────┐
   │                External Integrations                  │
   │  Hunter.io · Snov.io · Apollo · Common Room           │
   │  ScrapingBee / BrightData · NeverBounce / ZeroBounce  │
   │  Stripe · smartly.io (Custom Audience export)         │
   └───────────────────────────────────────────────────────┘
```

---

## 4. Data model (Postgres)

- `clients` — paying tenants (Chella is first row)
- `leads` — raw + scrubbed rows, FK to `client_id`
- `lead_events` — audit log (ingested, verified, exported, unsubscribed)
- `suppressions` — per-client blocklist (unsubs, bounces, competitors, existing customers)
- `sources` — where a batch came from (Yelp LA eyebrow-salons, Apollo query X, etc.) — required for CCPA audit
- `exports` — every CSV we generate, with hash + row count for reconciliation
- `subscriptions` — Stripe tier/status

See `supabase/migrations/0001_init.sql` for the SQL.

---

## 5. Scrubbing pipeline (the core IP)

Every lead passes through all 5 stages before it is eligible for export:

| Stage | Check | Tool | Reject if |
|---|---|---|---|
| 1. Syntax | RFC 5322 regex + disposable domain check | internal (`utils/scrub/email.ts`) | Malformed, obvious typos, disposable |
| 2. DNS/MX | Look up MX records for domain | Node `dns.promises` | No MX |
| 3. SMTP | Handshake check (RCPT TO) | NeverBounce or ZeroBounce API (bulk) | Hard bounce / unknown |
| 4. Dedupe | Normalize (lowercase, strip +tag) and hash | Postgres unique index on `(client_id, email_hash)` | Already in `leads` |
| 5. Suppression | Match against `suppressions` | SQL join | On blocklist |

Enrichment (runs in parallel, non-blocking): Hunter.io + Snov.io fills missing name/title/company/linkedin. Apollo fills B2B firmographics.

Target deliverability: **≥97% inbox rate** on exports to smartly.io Custom Audiences.

---

## 6. Lead sources — priority order

Based on your direction, speed-to-first-thousand-leads, and cost:

**Priority 1 — Already-connected APIs (build first, ship this week)**
- **Apollo** — B2B salons/retailers/MUA agencies. Connector is already wired in this project.
- **Common Room** — existing community/signal data. Connector wired.

**Priority 2 — Purchased/finder APIs (build week 2)**
- **Hunter.io** — domain search ($49/mo starter, 500 searches)
- **Snov.io** — bulk verify ($30/mo, 1k credits)
- **NeverBounce / ZeroBounce** — SMTP bulk verification
- **ZoomInfo** — high-accuracy US beauty buyers (enterprise, add at scale)

**Priority 3 — Ethical scraping (build week 3–4)**
- **ScrapingBee** — $49/mo, JS render, 95%+ success. Use for Yelp/Google Maps (salons), Instagram bio extraction (influencers).
- **BrightData** — $500/mo min, CCPA/GDPR certified, only if we need scale or hit blocks.
- **Rules:** always respect robots.txt + TOS; store `source_url` per row; never scrape private/auth-walled content.

**Priority 4 — First-party seeds**
- Chella's CRM customers → build lookalikes in smartly.io.
- Chella's email list → suppression (don't pay to acquire leads we already own).

---

## 7. Compliance (non-negotiable)

- **CCPA/GDPR consent banner** — iubenda or CookieYes on every public page.
- **Privacy policy + deletion request form** at `/privacy` and `/data-request`. Process deletions within 45 days (CCPA requirement).
- **Opt-out mechanism** — every email sent via smartly.io must include unsubscribe; we receive the webhook and add to `suppressions`.
- **Source logging** — every lead row stores `source` + `source_url` + `ingested_at` + `ingested_by` for audit.
- **No cold outreach from scraped-only data** without a verified opt-in signal — this is a hard rule, not a preference.
- **Audit with UpLead or TrustArc quarterly** for CCPA opt-out coverage.

---

## 8. Pricing (SaaS — sell beyond Chella)

| Tier | Price | For | Leads/mo | Exports/mo |
|---|---|---|---|---|
| **Starter** | $49/mo | Solo beauty brands | 2,500 scrubbed | 5 |
| **Growth** | $199/mo | Chella-sized DTC | 15,000 scrubbed | Unlimited |
| **Agency** | $499/mo | Multi-client agencies | 60,000 scrubbed | Unlimited + API |
| **Enterprise** | Custom | ZoomInfo-scale | Unlimited | Dedicated IP + SLA |

Stripe Checkout + customer portal. Metered overages on leads (e.g., $0.02 per scrubbed lead past tier).

---

## 9. Go-to-market (first 90 days)

| Week | Milestone |
|---|---|
| 1 | Domain registered, Next.js + Supabase deployed, schema live |
| 2 | Ingest from Apollo + Common Room working; Chella logged in to dashboard |
| 3 | Scrubbing edge function live; Hunter + NeverBounce integrated |
| 4 | First 1,000 scrubbed leads delivered to Chella; export to smartly.io Custom Audience tested |
| 5–6 | ScrapingBee Yelp/Instagram pipeline online; influencer ICP live |
| 7–8 | Stripe + tiered plans live; landing page pushed; start signing client #2 |
| 9–12 | 3–5 paying clients beyond Chella; automated nightly re-verification job |

---

## 10. Success metrics

- **Deliverability rate on exports** ≥ 97% (measured via smartly.io bounce report)
- **Cost per scrubbed lead** ≤ $0.08 blended
- **Time from raw ingest → export-eligible** ≤ 15 minutes
- **Chella campaign lift** — measurable ROAS improvement vs. current smartleads.io baseline within 60 days
- **ARR from non-Chella clients** — ≥ $2k MRR by day 90

---

## 11. Open questions to resolve with Keaton

- Domain registration — is `oneclickitleads.com` already purchased, or do we check availability first?
- Who owns Chella's smartly.io account — do we push audiences via API or hand off CSVs for now?
- Chella CRM access — Shopify? Klaviyo? Need export credentials to build suppression + lookalikes.
- Do we want a shared Chella Slack or Notion channel for weekly delivery + feedback?
