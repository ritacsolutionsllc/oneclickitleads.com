'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

type C = { id: string; name: string; slug: string; plan: string };

/**
 * Read/write active client via ?client=slug. Persistent across pages because
 * every dashboard page reads the query param, and the dropdown reloads the
 * current path with the new slug rather than jumping home.
 */
export default function ClientSwitcher({ clients }: { clients: C[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const activeSlug = params.get('client') ?? clients[0]?.slug ?? '';
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  if (clients.length === 0 && !creating) {
    return (
      <button
        onClick={() => setCreating(true)}
        className="rounded-full bg-emerald-600 text-white px-3 py-1 text-sm font-medium hover:bg-emerald-700"
      >
        + Create your first client
      </button>
    );
  }

  if (creating) {
    return (
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await fetch('/api/dashboard/clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: newName }),
          });
          const data = await res.json();
          if (data.slug) {
            window.location.href = `/dashboard?client=${data.slug}`;
          } else alert(data.error);
        }}
        className="flex items-center gap-2"
      >
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Client name, e.g. Chella"
          className="rounded-full border border-neutral-300 px-3 py-1 text-sm"
        />
        <button type="submit" className="text-sm font-medium text-emerald-700">Create</button>
        <button type="button" onClick={() => setCreating(false)} className="text-sm text-neutral-500">Cancel</button>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={activeSlug}
        onChange={(e) => {
          const url = new URL(window.location.href);
          url.searchParams.set('client', e.target.value);
          router.push(url.pathname + '?' + url.searchParams.toString());
        }}
        className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-sm"
      >
        {clients.map((c) => (
          <option key={c.id} value={c.slug}>
            {c.name} · {c.plan}
          </option>
        ))}
      </select>
      <button
        onClick={() => setCreating(true)}
        className="rounded-full border border-neutral-300 px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
        title="Add client"
      >
        +
      </button>
    </div>
  );
}
