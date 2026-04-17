'use client';

import { useState } from 'react';
import { PlanTier } from '@/lib/plans';

export default function SubscribeButton({
  tier,
  annual = false,
  children,
  className = '',
}: {
  tier: PlanTier;
  annual?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  const [loading, setLoading] = useState(false);

  async function go() {
    setLoading(true);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier, annual }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else if (data.error === 'unauthorized') window.location.href = `/login?next=/pricing`;
      else alert(data.error ?? 'Checkout error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={go}
      disabled={loading}
      className={className || 'rounded-full bg-emerald-600 text-white px-5 py-2.5 font-medium hover:bg-emerald-700 disabled:opacity-50'}
    >
      {loading ? 'Redirecting…' : children ?? 'Subscribe'}
    </button>
  );
}
