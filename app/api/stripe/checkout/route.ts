import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@/utils/supabase/server';
import { PLANS, PlanTier, stripePriceFor } from '@/lib/plans';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2025-09-30.acacia' as any });
}

/**
 * POST /api/stripe/checkout
 *   body: { tier: 'starter'|'growth'|'agency', annual?: boolean }
 *
 * Returns { url } for Stripe Checkout. The cancel_url sends the user back
 * to /pricing, the success_url lands them in the dashboard with a banner.
 */
export async function POST(req: Request) {
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: 'STRIPE_SECRET_KEY not configured' }, { status: 500 });

  const { tier = 'growth', annual = false } = (await req.json()) as {
    tier?: PlanTier;
    annual?: boolean;
  };

  const plan = PLANS[tier];
  if (!plan || !plan.selfServe) {
    return NextResponse.json({ error: 'unknown tier' }, { status: 400 });
  }

  // For the annual variant we look up a separate env var (STRIPE_PRICE_<TIER>_ANNUAL).
  // Falls back to the monthly price if annual isn't configured yet.
  const priceEnv = annual ? `${plan.stripePriceEnv}_ANNUAL` : plan.stripePriceEnv!;
  const price = process.env[priceEnv] ?? stripePriceFor(tier);

  if (!price) {
    return NextResponse.json(
      { error: `Stripe price not configured (${priceEnv})` },
      { status: 500 }
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // If the user already has a Stripe customer, reuse it so subscriptions merge
  const { data: client } = await supabase
    .from('clients')
    .select('stripe_customer_id')
    .eq('owner_user', user.id)
    .maybeSingle();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: client?.stripe_customer_id ?? undefined,
    customer_email: client?.stripe_customer_id ? undefined : user.email ?? undefined,
    line_items: [{ price, quantity: 1 }],
    subscription_data: {
      trial_period_days: 14,
      metadata: { tier, user_id: user.id },
    },
    allow_promotion_codes: true,
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?upgraded=1&tier=${tier}`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
    client_reference_id: user.id,
    metadata: { tier, annual: annual ? '1' : '0' },
  });

  return NextResponse.json({ url: session.url });
}
