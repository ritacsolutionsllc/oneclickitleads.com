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
    icpSegments: number | 'unlimited';  // how many ICPs they can run
    sources: ('places' | 'hunter' | 'apollo' | 'commonroom' | 'scrapingbee' | 'purchased')[];
    destinations: ('csv' | 'smartly' | 'meta_capi' | 'tiktok' | 'klaviyo_push')[];
    firstPartySync: boolean;
    suppressionList: boolean;
    scheduledScrubs: boolean;           // pg_cron nightly
    smtpVerification: boolean;          // NeverBounce/ZeroBounce
    emailEnrichment: boolean;           // Hunter.io
    customScrapes: boolean;             // custom city/query scraping — agency+ only
    inventoryAccess: boolean;           // pre-scraped US beauty database
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
    tagline: 'Validate one ICP, prove the funnel.',
    highlights: [
      '2,500 pre-scraped beauty leads / month',
      '1 ICP segment',
      'US beauty database (salons, medspas, retailers)',
      'CSV export',
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
    tagline: 'The Chella plan — multi-channel activation.',
    highlights: [
      '15,000 pre-scraped beauty leads / month',
      '4 ICP segments',
      'smartly.io + Meta CAPI push',
      'Shopify + Klaviyo first-party sync',
      'Nightly re-scrub',
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
    tagline: 'Run OneClickitLeads for your book of clients.',
    highlights: [
      '60,000 scrubbed leads / month',
      'Unlimited ICP segments',
      'Custom scraping — any city, query, or niche',
      'All destinations (smartly, Meta, TikTok, Klaviyo)',
      'White-label dashboard',
      'API access',
      'Dedicated onboarding',
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
      'Custom lead volume',
      'Custom scraping — unlimited',
      'SSO / SAML',
      'DPA + BAA on request',
      'VPC or on-prem deploy',
      'Named CSM',
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
    if (process.env[envName] === priceId || process.env[`${envName}_ANNUAL`] === priceId) return tier;
  }
  return 'starter';
}

export function formatMonthly(priceCents: number) {
  return `$${(priceCents / 100).toFixed(0)}`;
}

export function displayPlans(): Plan[] {
  return Object.values(PLANS).sort((a, b) => a.displayOrder - b.displayOrder);
}
