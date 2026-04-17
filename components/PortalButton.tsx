'use client';

import { useState } from 'react';

export default function PortalButton({
  children = 'Manage billing',
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const [loading, setLoading] = useState(false);

  async function go() {
    setLoading(true);
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else alert(data.error ?? 'Could not open billing portal');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={go}
      disabled={loading}
      className={className || 'rounded-full border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50'}
    >
      {loading ? 'Opening…' : children}
    </button>
  );
}
