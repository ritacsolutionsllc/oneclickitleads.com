'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

type Lead = {
  id: string;
  company: string | null;
  email: string | null;
  phone_e164: string | null;
  city: string | null;
  region: string | null;
  icp_segment: string | null;
  composite_score: number | null;
  scrub_score: number | null;
  created_at: string;
};

export default function ReviewPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [clientSlug, setClientSlug] = useState('');

  const load = useCallback(async (slug: string) => {
    if (!slug) return;
    setLoading(true);
    const res = await fetch(`/api/dashboard/review-leads?client=${encodeURIComponent(slug)}`);
    if (res.ok) setLeads(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    // Read client slug from URL
    const params = new URLSearchParams(window.location.search);
    const slug = params.get('client') ?? '';
    setClientSlug(slug);
    if (slug) load(slug);
    else setLoading(false);
  }, [load]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === leads.length) setSelected(new Set());
    else setSelected(new Set(leads.map((l) => l.id)));
  }

  async function act(action: 'approve' | 'reject') {
    if (!selected.size || !clientSlug) return;
    setActing(true);
    setMessage(null);
    const res = await fetch('/api/dashboard/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lead_ids: [...selected], action, client_slug: clientSlug }),
    });
    const data = await res.json();
    if (res.ok) {
      setMessage({ text: `${action === 'approve' ? 'Approved' : 'Rejected'} ${data.updated} lead${data.updated !== 1 ? 's' : ''}`, ok: true });
      setLeads((prev) => prev.filter((l) => !selected.has(l.id)));
      setSelected(new Set());
    } else {
      setMessage({ text: data.error ?? 'Action failed', ok: false });
    }
    setActing(false);
  }

  if (loading) {
    return <div className="h-64 rounded-xl border border-neutral-200 bg-white animate-pulse mt-6" />;
  }

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Review Queue</h1>
          <p className="text-sm text-neutral-600 mt-1">
            Leads scored 35–49 (composite) flagged for manual approval before export.
            Approve promotes to <em>Prospecting</em>; reject moves to <em>Discard</em>.
          </p>
        </div>
        <Link href="/dashboard/leads" className="rounded-full border border-neutral-300 px-4 py-2 text-sm hover:bg-white">
          All leads →
        </Link>
      </div>

      {message && (
        <div className={`mt-4 rounded-xl border px-5 py-3 text-sm ${message.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800'}`}>
          {message.text}
        </div>
      )}

      {leads.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <div className="text-lg font-medium">Queue is empty</div>
          <div className="mt-2 text-sm text-neutral-600">No leads awaiting review right now.</div>
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-neutral-200 bg-white overflow-hidden">
          {/* Action bar */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-100 bg-neutral-50">
            <input
              type="checkbox"
              checked={selected.size === leads.length && leads.length > 0}
              onChange={toggleAll}
              className="rounded"
            />
            <span className="text-sm text-neutral-600">
              {selected.size > 0 ? `${selected.size} selected` : `${leads.length} leads`}
            </span>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => act('approve')}
                disabled={!selected.size || acting}
                className="rounded-full bg-emerald-600 text-white px-4 py-1.5 text-sm hover:bg-emerald-700 disabled:opacity-40"
              >
                Approve
              </button>
              <button
                onClick={() => act('reject')}
                disabled={!selected.size || acting}
                className="rounded-full border border-red-300 text-red-700 px-4 py-1.5 text-sm hover:bg-red-50 disabled:opacity-40"
              >
                Reject
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="px-4 py-3 w-8" />
                  <th className="text-left px-4 py-3">Company</th>
                  <th className="text-left px-4 py-3">Email</th>
                  <th className="text-left px-4 py-3">Phone</th>
                  <th className="text-left px-4 py-3">Location</th>
                  <th className="text-left px-4 py-3">Segment</th>
                  <th className="text-left px-4 py-3">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {leads.map((l) => (
                  <tr
                    key={l.id}
                    className={`hover:bg-neutral-50 cursor-pointer ${selected.has(l.id) ? 'bg-emerald-50' : ''}`}
                    onClick={() => toggle(l.id)}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(l.id)}
                        onChange={() => toggle(l.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded"
                      />
                    </td>
                    <td className="px-4 py-3 font-medium">{l.company ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs">{l.email ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs">{l.phone_e164 ?? '—'}</td>
                    <td className="px-4 py-3">{l.city ? `${l.city}${l.region ? `, ${l.region}` : ''}` : '—'}</td>
                    <td className="px-4 py-3">
                      {l.icp_segment ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">{l.icp_segment}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 font-medium text-amber-700">
                      {l.composite_score != null ? Math.round(Number(l.composite_score)) : (l.scrub_score ?? '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
