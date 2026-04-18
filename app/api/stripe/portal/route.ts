import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@/utils/supabase/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-02-24.acacia' });

/**
 * POST /api/stripe/portal
 * Creates a Stripe billing portal session for the signed-in user's client.
 * Returns { url } for the client-side <PortalButton /> to redirect to.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: client } = await supabase
    .from('clients')
    .select('stripe_customer_id')
    .eq('owner_user', user.id)
    .maybeSingle();

  if (!client?.stripe_customer_id) {
    return NextResponse.json(
      { error: 'No Stripe customer on file — subscribe first.' },
      { status: 400 }
    );
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: client.stripe_customer_id,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing`,
  });

  return NextResponse.json({ url: portal.url });
}
