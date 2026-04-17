'use client';

import { useState, useTransition } from 'react';

type Row = { id: string; email: string | null; phone: string | null; reason: string | null; added_at: string };

export default function SuppressionManager({
  clientSlug,
  initial,
}: {
  clientSlug: string;
  initial: Row[];
}) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [bulk, setBulk] = useState('');
  const [reason, setReason] = useState('unsubscribed');
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState('');

  async function add() {
    const lines = bulk.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    const res = await fetch('/api/dashboard/suppressions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_slug: clientSlug, entries: lines, reason }),
    });
    const data = await res.json();
    if (data.added) {
      setRows([...(data.rows ?? []), ...rows]);
      setBulk('');
    } else {
      alert(data.error ?? 'Failed');
    }
  }

  async function remove(id: string) {
    startTransition(async () => {
      const res = await fetch(`/api/dashboard/suppressions?id=${id}`, { method: 'DELETE' });
      if (res.ok) setRows((xs) => xs.filter((x) => x.id !== id));
    });
  }

  const filtered = rows.filter(
    (r) => !filter || (r.email ?? '').includes(filter) || (r.phone ?? '').includes(filter)
  );

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="font-medium">Add suppressions</div>
        <p className="text-xs text-neutral-500 mt-1">
          Paste one email or E.164 phone per line. They'll be blocked from every future export.
        </p>
        <textarea
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          rows={5}
          placeholder={`sarah@example.com\n+15551234567\nnope@example.com`}
          className="mt-3 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono"
        />
        <div className="mt-3 flex items-center gap-3">
          <select value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">
            <option value="unsubscribed">Unsubscribed</option>
            <option value="bounced">Bounced</option>
            <option value="spam">Spam complaint</option>
            <option value="existing_customer">Existing customer</option>
            <option value="competitor">Competitor</option>
            <option value="other">Other</option>
          </select>
          <button
            onClick={add}
            className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700"
          >
            Add
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <div className="font-medium">Recent ({filtered.length})</div>
          <input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </div>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs text-neutral-500 uppercase">
            <tr>
              <th className="pb-2">Email / Phone</th>
              <th className="pb-2">Reason</th>
              <th className="pb-2">Added</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {filtered.map((r) => (
              <tr key={r.id}>
                <td className="py-2 font-mono text-xs">{r.email ?? r.phone}</td>
                <td className="py-2">
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">{r.reason ?? '—'}</span>
                </td>
                <td className="py-2 text-neutral-500 text-xs">{new Date(r.added_at).toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => remove(r.id)}
                    disabled={pending}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="py-6 text-center text-neutral-500 text-sm">No suppressions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
