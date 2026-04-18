import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createAdminClient } from '@/utils/supabase/server';
import { tierForStripePriceId, PlanTier } from '@/lib/plans';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key, { apiVersion: '2025-02-24.acacia' });
}

/**
 * Webhook responsibilities:
 *   1. checkout.session.completed — create/attach subscription row, stamp
 *      stripe_customer_id + stripe_subscription_id onto the client, set plan.
 *   2. customer.subscription.updated — keep client.plan and status in sync;
 *      catches plan upgrades/downgrades done in the customer portal.
 *   3. customer.subscription.deleted — downgrade client to 'starter' and null
 *      out the subscription (keeps data accessible under the free cap).
 *   4. invoice.payment_failed — flag the client as past_due so the UI can nag.
 *
 * Everything uses the admin Supabase client because the incoming webhook
 * has no user session.
 */
export async function POST(req: Request) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET is not set' }, { status: 500 });
  }
  const sig = req.headers.get('stripe-signature');
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig!, webhookSecret);
  } catch (err) {
    return NextResponse.json({ error: `signature: ${(err as Error).message}` }, { status: 400 });
  }

  const supabase = createAdminClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const clientRef = s.client_reference_id; // Supabase user.id
        const subId = s.subscription as string | null;
        const custId = s.customer as string | null;
        const tier = (s.metadata?.tier as PlanTier) ?? 'starter';

        // Fetch the subscription to get current period end + price
        let periodEnd: string | null = null;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          periodEnd = new Date(sub.current_period_end * 1000).toISOString();
        }

        // Upsert subscription row
        await supabase.from('subscriptions').upsert(
          {
            stripe_customer_id: custId,
            stripe_subscription_id: subId,
            tier,
            status: 'active',
            current_period_end: periodEnd,
            user_id: clientRef,
          },
          { onConflict: 'stripe_subscription_id' }
        );

        // Attach the Stripe ids to the client + upgrade plan
        if (clientRef) {
          await supabase
            .from('clients')
            .update({
              plan: tier,
              stripe_customer_id: custId,
              stripe_subscription_id: subId,
              plan_current_period_end: periodEnd,
            })
            .eq('owner_user', clientRef);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const priceId = sub.items.data[0]?.price.id ?? null;
        const tier = tierForStripePriceId(priceId);
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString();

        await supabase
          .from('subscriptions')
          .update({
            tier,
            status: sub.status,
            current_period_end: periodEnd,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', sub.id);

        // Keep clients.plan in sync — covers portal upgrades/downgrades
        await supabase
          .from('clients')
          .update({
            plan: sub.status === 'active' || sub.status === 'trialing' ? tier : 'starter',
            plan_current_period_end: periodEnd,
          })
          .eq('stripe_subscription_id', sub.id);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await supabase
          .from('subscriptions')
          .update({ status: 'canceled', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);

        // Downgrade — data stays, but caps enforce
        await supabase
          .from('clients')
          .update({ plan: 'starter', stripe_subscription_id: null })
          .eq('stripe_subscription_id', sub.id);
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        if (inv.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', inv.subscription as string);
        }
        break;
      }

      default:
        // Silent: Stripe sends many events we don't care about (payment_intent.*, etc.)
        break;
    }
  } catch (err) {
    // Don't let handler errors cause Stripe to retry forever — log and ack
    console.error(`[stripe webhook] ${event.type}`, err);
    return NextResponse.json({ received: true, handled: false, error: String(err) });
  }

  return NextResponse.json({ received: true });
}
