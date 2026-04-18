'use client';

import { useState } from 'react';
import { displayPlans, Plan } from '@/lib/plans';

/**
 * Shared pricing grid used on /pricing and the landing page.
 * - Monthly / annual toggle.
 * - Client-side checkout button that hits /api/stripe/checkout.
 * - "Talk to sales" CTA for enterprise.
 */
export default function PricingGrid({ compact = false }: { compact?: boolean }) {
  const [annual, setAnnual] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const plans = displayPlans();

  async function checkout(plan: Plan) {
    if (!plan.selfServe) {
      window.location.href = `mailto:contact@oneclickit.ai?subject=Enterprise%20inquiry`;
      return;
    }
    setLoading(plan.tier);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: plan.tier, annual }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else if (data.error === 'unauthorized') window.location.href = `/login?next=/pricing`;
      else alert(data.error ?? 'Checkout error');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-center gap-3 mb-8">
        <span className={annual ? 'text-neutral-400' : 'font-semibold'}>Monthly</span>
        <button
          onClick={() => setAnnual((a) => !a)}
          className="relative h-6 w-12 rounded-full bg-emerald-600 transition"
          aria-label="Toggle annual billing"
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
              annual ? 'left-6' : 'left-0.5'
            }`}
          />
        </button>
        <span className={annual ? 'font-semibold' : 'text-neutral-400'}>
          Annual <span className="text-emerald-700 text-sm">(save ~20%)</span>
        </span>
      </div>

      <div className={`grid gap-6 ${compact ? 'md:grid-cols-4' : 'md:grid-cols-2 lg:grid-cols-4'}`}>
        {plans.map((plan) => {
          const price = plan.priceMonthly === 0
            ? 'Custom'
            : annual && plan.priceYearlyPerMonth
              ? `$${plan.priceYearlyPerMonth}`
              : `$${plan.priceMonthly}`;
          const isFeatured = plan.tier === 'growth';
          return (
            <div
              key={plan.tier}
              className={`relative rounded-2xl border p-6 flex flex-col ${
                isFeatured
                  ? 'border-emerald-500 bg-emerald-50 shadow-md'
                  : 'border-neutral-200 bg-white'
              }`}
            >
              {isFeatured && (
                <div className="absolute -top-3 left-6 rounded-full bg-emerald-600 px-3 py-0.5 text-xs font-medium text-white">
                  Most popular
                </div>
              )}
              <div className="text-lg font-semibold">{plan.name}</div>
              <div className="mt-1 text-sm text-neutral-600">{plan.tagline}</div>
              <div className="mt-4">
                <span className="text-4xl font-bold">{price}</span>
                {plan.priceMonthly > 0 && (
                  <span className="text-neutral-500">/mo</span>
                )}
                {annual && plan.priceYearlyPerMonth && (
                  <div className="text-xs text-neutral-500 mt-1">
                    ${plan.priceYearlyPerMonth * 12} billed annually
                  </div>
                )}
              </div>

              <ul className="mt-5 space-y-2 text-sm flex-1">
                {plan.highlights.map((h) => (
                  <li key={h} className="flex gap-2">
                    <span className="text-emerald-600">✓</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>

              <button
                onClick={() => checkout(plan)}
                disabled={loading === plan.tier}
                className={`mt-6 rounded-full px-4 py-2.5 font-medium transition ${
                  isFeatured
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : plan.selfServe
                      ? 'border border-neutral-300 hover:bg-neutral-100'
                      : 'bg-neutral-900 text-white hover:bg-neutral-800'
                }`}
              >
                {loading === plan.tier
                  ? 'Redirecting…'
                  : plan.selfServe
                    ? 'Start free trial'
                    : 'Talk to sales'}
              </button>

              {plan.selfServe && (
                <div className="mt-2 text-center text-xs text-neutral-500">
                  14-day free trial · cancel any time
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 text-center text-sm text-neutral-500">
        All plans include email syntax + MX + SMTP scrubbing, per-client suppression, and CCPA audit trail.
      </div>
    </div>
  );
}
