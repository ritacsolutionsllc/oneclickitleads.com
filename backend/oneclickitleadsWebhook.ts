/**
 * oneclickitleadsWebhook — Stripe webhook for OneClickitLeads
 * Updates UserSubscription entity on payment events
 *
 * Endpoint: https://superagent-b2d614b7.base44.app/functions/oneclickitleadsWebhook
 * Register in Stripe Dashboard → Webhooks
 * Events: checkout.session.completed, customer.subscription.deleted, customer.subscription.updated
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.21.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', { apiVersion: '2024-04-10' });

const PLAN_MAP: Record<string, string> = {
  starter_monthly: 'starter',
  starter_annual:  'starter',
  growth_monthly:  'growth',
  growth_annual:   'growth',
  agency_monthly:  'agency',
  agency_annual:   'agency',
};

// Lead quota per plan (leads/month)
const PLAN_QUOTA: Record<string, number> = {
  free:    0,
  starter: 500,
  growth:  2500,
  agency:  999999, // unlimited
};

Deno.serve(async (req) => {
  try {
    const body = await req.text();
    const sig  = req.headers.get('stripe-signature') ?? '';
    const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, secret);
    } catch (err) {
      return Response.json({ error: `Signature failed: ${err.message}` }, { status: 400 });
    }

    const base44 = createClientFromRequest(req);

    // ── checkout.session.completed ─────────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta    = session.metadata ?? {};
      const userEmail     = meta.base44_user_email ?? session.customer_email ?? '';
      const rawPlan       = meta.plan ?? '';
      const plan          = PLAN_MAP[rawPlan] ?? rawPlan;
      const customerId    = typeof session.customer    === 'string' ? session.customer    : (session.customer    as Stripe.Customer)?.id    ?? '';
      const subscriptionId= typeof session.subscription=== 'string' ? session.subscription: (session.subscription as Stripe.Subscription)?.id ?? '';
      const quota         = PLAN_QUOTA[plan] ?? 0;
      const periodEnd     = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      if (userEmail) {
        const existing = await base44.asServiceRole.entities.UserSubscription.filter({ user_email: userEmail });
        const payload = {
          user_email:            userEmail,
          plan,
          status:                'active',
          stripe_customer_id:    customerId,
          stripe_subscription_id:subscriptionId,
          current_period_end:    periodEnd,
          monthly_lead_quota:    quota,
          leads_used_this_month: 0,
        };
        if (existing.length > 0) {
          await base44.asServiceRole.entities.UserSubscription.update(existing[0].id, payload);
        } else {
          await base44.asServiceRole.entities.UserSubscription.create(payload);
        }
        console.log(`✅ OneClickitLeads subscription activated: ${userEmail} → ${plan}`);
      }
    }

    // ── customer.subscription.deleted ─────────────────────────────────────
    if (event.type === 'customer.subscription.deleted') {
      const sub       = event.data.object as Stripe.Subscription;
      const userEmail = sub.metadata?.base44_user_email ?? '';
      if (userEmail) {
        const existing = await base44.asServiceRole.entities.UserSubscription.filter({ user_email: userEmail });
        if (existing.length > 0) {
          await base44.asServiceRole.entities.UserSubscription.update(existing[0].id, {
            plan:               'free',
            status:             'cancelled',
            monthly_lead_quota: 0,
          });
        }
        console.log(`⚠️ OneClickitLeads subscription cancelled: ${userEmail}`);
      }
    }

    // ── customer.subscription.updated ─────────────────────────────────────
    if (event.type === 'customer.subscription.updated') {
      const sub       = event.data.object as Stripe.Subscription;
      const userEmail = sub.metadata?.base44_user_email ?? '';
      const status    = sub.status; // active, past_due, canceled, etc.
      if (userEmail && status === 'past_due') {
        const existing = await base44.asServiceRole.entities.UserSubscription.filter({ user_email: userEmail });
        if (existing.length > 0) {
          await base44.asServiceRole.entities.UserSubscription.update(existing[0].id, { status: 'past_due' });
        }
        console.log(`⚠️ OneClickitLeads past_due: ${userEmail}`);
      }
    }

    return Response.json({ received: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
});
