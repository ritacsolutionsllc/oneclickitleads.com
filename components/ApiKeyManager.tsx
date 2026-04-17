'use client';

import { useState } from 'react';

type Row = {
  id: string; key_prefix: string; label: string | null; last_used: string | null;
  created_at: string; revoked_at: string | null;
};

export default function ApiKeyManager({ clientSlug, initial }: { clientSlug: string; initial: Row[] }) {
  const [rows, setRows] = useState(initial);
  const [label, setLabel] = useState('');
  const [reveal, setReveal] = useState<string | null>(null); // raw key shown once

  async function create() {
    const res = await fetch('/api/dashboard/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_slug: clientSlug, label }),
    });
    const data = await res.json();
    if (data.key) {
      setReveal(data.key);
      setRows([data.row, ...rows]);
      setLabel('');
    } else alert(data.error);
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this key? Any integrations using it will immediately break.')) return;
    const res = await fetch(`/api/dashboard/api-keys?id=${id}`, { method: 'DELETE' });
    if (res.ok) setRows((xs) => xs.map((r) => r.id === id ? { ...r, revoked_at: new Date().toISOString() } : r));
  }

  return (
    <div className="mt-4">
      <div className="flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label, e.g. production-ingest"
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        />
        <button
          onClick={create}
          className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700"
        >
          Generate key
        </button>
      </div>

      {reveal && (
        <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4">
          <div className="text-xs text-emerald-800 font-semibold">SAVE THIS KEY NOW</div>
          <div className="mt-1 text-xs text-neutral-600">It's shown only once. We store a hash, not the raw value.</div>
          <div className="mt-2 font-mono text-sm bg-white rounded px-3 py-2 border border-emerald-200 break-all">{reveal}</div>
          <button onClick={() => setReveal(null)} className="mt-2 text-xs text-emerald-700 hover:underline">Done — I've saved it</button>
        </div>
      )}

      <table className="mt-6 w-full text-sm">
        <thead className="text-left text-xs text-neutral-500 uppercase">
          <tr><th className="pb-2">Prefix</th><th className="pb-2">Label</th><th className="pb-2">Last used</th><th className="pb-2">Status</th><th></th></tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="py-2 font-mono text-xs">{r.key_prefix}…</td>
              <td className="py-2">{r.label ?? '—'}</td>
              <td className="py-2 text-xs text-neutral-500">
                {r.last_used ? new Date(r.last_used).toLocaleString() : 'never'}
              </td>
              <td className="py-2">
                {r.revoked_at
                  ? <span className="text-xs rounded-full bg-red-50 text-red-800 px-2 py-0.5">revoked</span>
                  : <span className="text-xs rounded-full bg-emerald-50 text-emerald-800 px-2 py-0.5">active</span>}
              </td>
              <td className="py-2 text-right">
                {!r.revoked_at && (
                  <button onClick={() => revoke(r.id)} className="text-xs text-red-600 hover:underline">Revoke</button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-neutral-500 text-sm">No API keys yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
