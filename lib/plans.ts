/**
 * Single source of truth for OneClickitLeads pricing + plan capabilities.
 *
 * Used by:
 *   - /pricing and landing page pricing grid
 *   - /api/stripe/checkout (price lookup)
 *   - /api/stripe/webhook (map price → tier → client plan)
 *   - /api/export (enforce monthly cap)
 *   - Dashboard billing page
 *   - ScrapeForm (customScrapes gate)
 *
 * When adding a plan, also:
 *   1. Create a Stripe Price in dashboard + set STRIPE_PRICE_<TIER> env var
 *   2. Update supabase v_client_usage `case c.plan` block
 */

export type PlanTier = 'starter' | 'growth' | 'agency' | 'enterprise';

export type Plan = {
  tier: PlanTier;
  name: string;
  priceMonthly: number;                 // USD
  priceYearlyPerMonth?: number;         // USD (optional annual)
  tagline: string;
  highlights: string[];
  features: {
    monthlyCleanLeads: number;          // hard cap used by export route
    /** ICP = Ideal Customer Profile — the type of business you're targeting.
     *  e.g. "hair salons", "medspas", "restaurants", "real estate agents". */
    icpSegments: number | 'unlimited';
    sources: ('places' | 'hunter' | 'apollo' | 'commonroom' | 'scrapingbee' | 'purchased')[];
    destinations: ('csv' | 'smartly' | 'meta_capi' | 'tiktok' | 'klaviyo_push')[];
    firstPartySync: boolean;            // shopify + klaviyo import
    suppressionList: boolean;
    scheduledScrubs: boolean;           // pg_cron nightly
    smtpVerification: boolean;          // NeverBounce/ZeroBounce
    emailEnrichment: boolean;           // Hunter.io
    /** Custom city/query scraping via Google Places — any industry, any geography. Agency+ only. */
    customScrapes: boolean;
    /** Access to our pre-scraped shared database, updated nightly. */
    inventoryAccess: boolean;
    support: 'community' | 'email' | 'priority' | 'dedicated';
    whitelabel: boolean;
    apiAccess: boolean;
  };
  /** Env var name holding the Stripe price ID. */
  stripePriceEnv?: string;
  /** Whether this plan is bookable via self-serve checkout. */
  selfServe: boolean;
  /** Ordering for display. */
  displayOrder: number;
};

export const PLANS: Record<PlanTier, Plan> = {
  starter: {
    tier: 'starter',
    name: 'Starter',
    priceMonthly: 49,
    priceYearlyPerMonth: 39,
    tagline: 'Prove your list before you scale.',
    highlights: [
      '2,500 verified leads / month from our pre-built database',
      '1 ICP segment — pick your niche (salons, medspas, retailers, etc.)',
      'Email scrubbing: syntax + MX + SMTP validation on every address',
      'CSV export — import into any email or CRM platform',
      'Suppression list — never re-contact existing customers or unsubs',
      'Email support',
    ],
    features: {
      monthlyCleanLeads: 2_500,
      icpSegments: 1,
      sources: ['places', 'hunter'],
      destinations: ['csv'],
      firstPartySync: false,
      suppressionList: true,
      scheduledScrubs: false,
      smtpVerification: true,
      emailEnrichment: true,
      customScrapes: false,
      inventoryAccess: true,
      support: 'email',
      whitelabel: false,
      apiAccess: false,
    },
    stripePriceEnv: 'STRIPE_PRICE_STARTER',
    selfServe: true,
    displayOrder: 1,
  },
  growth: {
    tier: 'growth',
    name: 'Growth',
    priceMonthly: 199,
    priceYearlyPerMonth: 159,
    tagline: 'Multi-channel activation across beauty, wellness, and retail.',
    highlights: [
      '15,000 verified leads / month',
      '4 ICP segments — target multiple niches simultaneously',
      'Push to smartly.io + Meta CAPI for paid-media custom audiences',
      'Klaviyo integration — sync leads directly into your email flows',
      'Shopify first-party sync — suppress existing customers automatically',
      'Nightly re-scrub — leads stay fresh as email addresses change',
      'Priority support',
    ],
    features: {
      monthlyCleanLeads: 15_000,
      icpSegments: 4,
      sources: ['places', 'hunter', 'apollo', 'commonroom', 'scrapingbee'],
      destinations: ['csv', 'smartly', 'meta_capi', 'klaviyo_push'],
      firstPartySync: true,
      suppressionList: true,
      scheduledScrubs: true,
      smtpVerification: true,
      emailEnrichment: true,
      customScrapes: false,
      inventoryAccess: true,
      support: 'priority',
      whitelabel: false,
      apiAccess: true,
    },
    stripePriceEnv: 'STRIPE_PRICE_GROWTH',
    selfServe: true,
    displayOrder: 2,
  },
  agency: {
    tier: 'agency',
    name: 'Agency',
    priceMonthly: 499,
    priceYearlyPerMonth: 399,
    tagline: 'Unlimited ICPs. Custom scraping. All destinations.',
    highlights: [
      '60,000 verified leads / month',
      'Unlimited ICP segments — any industry, any niche',
      'Custom scraping — any city, any query (beauty, fitness, restaurants, real estate, …)',
      'All destinations: CSV, smartly.io, Meta CAPI, TikTok, Klaviyo',
      'White-label dashboard — run it as your own product for clients',
      'REST API access for custom integrations',
      'Dedicated onboarding + priority Slack support',
    ],
    features: {
      monthlyCleanLeads: 60_000,
      icpSegments: 'unlimited',
      sources: ['places', 'hunter', 'apollo', 'commonroom', 'scrapingbee', 'purchased'],
      destinations: ['csv', 'smartly', 'meta_capi', 'tiktok', 'klaviyo_push'],
      firstPartySync: true,
      suppressionList: true,
      scheduledScrubs: true,
      smtpVerification: true,
      emailEnrichment: true,
      customScrapes: true,
      inventoryAccess: true,
      support: 'dedicated',
      whitelabel: true,
      apiAccess: true,
    },
    stripePriceEnv: 'STRIPE_PRICE_AGENCY',
    selfServe: true,
    displayOrder: 3,
  },
  enterprise: {
    tier: 'enterprise',
    name: 'Enterprise',
    priceMonthly: 0, // custom
    tagline: 'Custom volume, DPA, SSO, deployed in your VPC.',
    highlights: [
      'Custom lead volume — no artificial caps',
      'Unlimited ICP segments across any industry globally',
      'Custom scraping at scale — bulk city/niche sweeps on a schedule',
      'All destinations + custom webhook integrations',
      'SSO / SAML authentication',
      'DPA + BAA available on request',
      'VPC or on-prem deploy option',
      'Named Customer Success Manager',
    ],
    features: {
      monthlyCleanLeads: 1_000_000,
      icpSegments: 'unlimited',
      sources: ['places', 'hunter', 'apollo', 'commonroom', 'scrapingbee', 'purchased'],
      destinations: ['csv', 'smartly', 'meta_capi', 'tiktok', 'klaviyo_push'],
      firstPartySync: true,
      suppressionList: true,
      scheduledScrubs: true,
      smtpVerification: true,
      emailEnrichment: true,
      customScrapes: true,
      inventoryAccess: true,
      support: 'dedicated',
      whitelabel: true,
      apiAccess: true,
    },
    selfServe: false,
    displayOrder: 4,
  },
};

export const PLAN_ORDER: PlanTier[] = ['starter', 'growth', 'agency', 'enterprise'];

export function planByTier(tier: string | null | undefined): Plan {
  const t = (tier ?? 'starter') as PlanTier;
  return PLANS[t] ?? PLANS.starter;
}

export function canCustomScrape(tier: string | null | undefined): boolean {
  return planByTier(tier).features.customScrapes;
}

export function stripePriceFor(tier: PlanTier): string | undefined {
  const plan = PLANS[tier];
  if (!plan.stripePriceEnv) return undefined;
  return process.env[plan.stripePriceEnv];
}

/**
 * Reverse map: given a Stripe price ID from a webhook, figure out which
 * tier we're dealing with. Returns 'starter' as a safe default if the price
 * doesn't match any known tier (customer still gets *some* access).
 */
export function tierForStripePriceId(priceId: string | null | undefined): PlanTier {
  if (!priceId) return 'starter';
  for (const tier of PLAN_ORDER) {
    const envName = PLANS[tier].stripePriceEnv;
    if (!envName) continue;
    if (process.env[envName] === priceId) return tier;
  }
  return 'starter';
}

export function formatMonthly(priceCents: number) {
  return `$${(priceCents / 100).toFixed(0)}`;
}

export function displayPlans(): Plan[] {
  return Object.values(PLANS).sort((a, b) => a.displayOrder - b.displayOrder);
}
