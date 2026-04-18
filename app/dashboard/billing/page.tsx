import { createClient } from '@/utils/supabase/server';
import Link from 'next/link';
import { planByTier, displayPlans, PLANS } from '@/lib/plans';
import PortalButton from '@/components/PortalButton';
import SubscribeButton from '@/components/SubscribeButton';

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients')
    .select('id, slug, name, plan, stripe_customer_id, stripe_subscription_id, plan_current_period_end')
    .eq('owner_user', user.id);
  const active = (clients ?? []).find((c) => c.slug === sp.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const plan = planByTier(active.plan);
  const hasSub = Boolean(active.stripe_subscription_id);

  const { data: usage } = await supabase
    .from('v_client_usage')
    .select('clean_this_month, monthly_cap, segments_used_this_month')
    .eq('client_id', active.id)
    .maybeSingle();
  const used = Number(usage?.clean_this_month ?? 0);
  const cap = Number(usage?.monthly_cap ?? plan.features.monthlyCleanLeads);
  const pct = Math.min(100, Math.round((used / cap) * 100));

  return (
    <div>
      <h1 className="text-2xl font-semibold">Billing</h1>
      <p className="text-sm text-neutral-600">Manage your subscription, view usage, and switch plans.</p>

      {/* Current plan */}
      <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-6">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-wider text-neutral-500">Current plan</div>
            <div className="mt-1 text-2xl font-semibold">{plan.name}</div>
            <div className="text-sm text-neutral-600">{plan.tagline}</div>
            {active.plan_current_period_end && (
              <div className="mt-2 text-xs text-neutral-500">
                Renews {new Date(active.plan_current_period_end).toLocaleDateString()}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {hasSub ? (
              <PortalButton className="rounded-full bg-neutral-900 text-white px-4 py-2 text-sm hover:bg-neutral-800">
                Manage in Stripe
              </PortalButton>
            ) : (
              <Link href="/pricing" className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700">
                Start subscription
              </Link>
            )}
          </div>
        </div>

        {/* Usage meter */}
        <div className="mt-6">
          <div className="flex items-baseline justify-between text-sm">
            <div className="text-neutral-600">Clean leads this month</div>
            <div><strong>{used.toLocaleString()}</strong> / {cap.toLocaleString()}</div>
          </div>
          <div className="mt-2 h-2 rounded-full bg-neutral-100 overflow-hidden">
            <div
              className={`h-full ${pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Switch plan */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold">Change plan</h2>
        <div className="mt-4 grid md:grid-cols-3 gap-4">
          {displayPlans().filter((p) => p.tier !== 'enterprise').map((p) => {
            const isCurrent = p.tier === plan.tier;
            return (
              <div key={p.tier} className={`rounded-xl border p-5 ${isCurrent ? 'border-emerald-500 bg-emerald-50' : 'border-neutral-200 bg-white'}`}>
                <div className="flex items-baseline justify-between">
                  <div className="font-semibold">{p.name}</div>
                  {isCurrent && <span className="text-xs rounded-full bg-emerald-600 text-white px-2 py-0.5">Current</span>}
                </div>
                <div className="mt-1 text-2xl font-semibold">${p.priceMonthly}<span className="text-sm text-neutral-500">/mo</span></div>
                <div className="mt-1 text-xs text-neutral-500">{p.features.monthlyCleanLeads.toLocaleString()} clean leads/mo</div>
                {!isCurrent && (
                  hasSub ? (
                    <PortalButton className="mt-4 w-full rounded-full border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100">
                      {p.priceMonthly > plan.priceMonthly ? 'Upgrade in portal' : 'Downgrade in portal'}
                    </PortalButton>
                  ) : (
                    <SubscribeButton
                      tier={p.tier}
                      className="mt-4 w-full rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700"
                    >
                      Subscribe
                    </SubscribeButton>
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Enterprise */}
      <div className="mt-10 rounded-xl border border-neutral-900 bg-neutral-900 text-white p-6 flex flex-wrap justify-between items-center gap-4">
        <div>
          <div className="font-semibold">Need more than 60k leads/month, white-label, or SSO?</div>
          <div className="text-sm text-neutral-300 mt-1">We'll spin up a custom plan with a DPA + dedicated onboarding.</div>
        </div>
        <a href="mailto:contact@oneclickit.ai" className="rounded-full bg-emerald-500 text-black px-4 py-2 text-sm font-medium hover:bg-emerald-400">
          Talk to sales
        </a>
      </div>
    </div>
  );
}
