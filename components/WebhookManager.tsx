'use client';

import { useState } from 'react';

type Row = { id: string; url: string; events: string[]; active: boolean; created_at: string };

export default function WebhookManager({ clientSlug, initial }: { clientSlug: string; initial: Row[] }) {
  const [rows, setRows] = useState(initial);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['export.completed', 'scrub.completed']);

  async function add() {
    if (!url) return;
    const res = await fetch('/api/dashboard/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_slug: clientSlug, url, events }),
    });
    const data = await res.json();
    if (data.row) { setRows([data.row, ...rows]); setUrl(''); }
    else alert(data.error);
  }

  async function remove(id: string) {
    const res = await fetch(`/api/dashboard/webhooks?id=${id}`, { method: 'DELETE' });
    if (res.ok) setRows((xs) => xs.filter((r) => r.id !== id));
  }

  return (
    <div className="mt-4">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/webhooks/oneclickitleads"
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        />
        <button onClick={add} className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700">
          Add webhook
        </button>
      </div>
      <div className="mt-3 flex gap-3 text-sm">
        {['export.completed', 'scrub.completed', 'lead.rejected'].map((e) => (
          <label key={e} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={events.includes(e)}
              onChange={(ev) => setEvents(ev.target.checked ? [...events, e] : events.filter((x) => x !== e))}
            />
            <span className="font-mono text-xs">{e}</span>
          </label>
        ))}
      </div>

      <table className="mt-6 w-full text-sm">
        <thead className="text-left text-xs text-neutral-500 uppercase">
          <tr><th className="pb-2">URL</th><th className="pb-2">Events</th><th className="pb-2">Status</th><th></th></tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="py-2 font-mono text-xs break-all max-w-md">{r.url}</td>
              <td className="py-2 text-xs text-neutral-600">{r.events.join(', ')}</td>
              <td className="py-2">
                {r.active ? <span className="text-xs rounded-full bg-emerald-50 text-emerald-800 px-2 py-0.5">active</span>
                          : <span className="text-xs rounded-full bg-neutral-100 text-neutral-700 px-2 py-0.5">paused</span>}
              </td>
              <td className="py-2 text-right">
                <button onClick={() => remove(r.id)} className="text-xs text-red-600 hover:underline">Remove</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-neutral-500">No webhooks yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
