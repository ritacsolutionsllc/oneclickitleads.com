'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  EligibilityPill,
  SourceTierBadge,
  QualityScore,
  ReasonCodeChips,
} from './QualityBadges';

type Lead = {
  id: string;
  email: string | null;
  phone_e164: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  city: string | null;
  region: string | null;
  icp_segment: string | null;
  quality_score: number | null;
  verification_status: string | null;
  source_tier: string | null;
  export_eligibility: string | null;
  reason_codes: string[] | null;
  last_verified_at: string | null;
  created_at: string;
};

type Action = 'approve' | 'reject' | 'requeue';

export default function ReviewQueueTable({
  initialLeads,
  state,
}: {
  initialLeads: Lead[];
  state: 'review' | 'quarantine' | 'rejected';
}) {
  const router = useRouter();
  const [items, setItems] = useState<Lead[]>(initialLeads);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  async function act(id: string, action: Action) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: id, action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setItems((xs) => xs.filter((x) => x.id !== id));
      start(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center text-sm text-neutral-500">
        Nothing in the {state} queue. Quality-first means this empty state is a good thing.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      {error && (
        <div className="border-b border-red-200 bg-red-50 text-red-800 px-4 py-2 text-sm">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 text-neutral-600 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-3">Lead</th>
              <th className="text-left px-4 py-3">Score</th>
              <th className="text-left px-4 py-3">Tier</th>
              <th className="text-left px-4 py-3">Eligibility</th>
              <th className="text-left px-4 py-3">Why</th>
              <th className="text-right px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {items.map((l) => {
              const fullName =
                l.first_name || l.last_name
                  ? `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim()
                  : null;
              return (
                <tr key={l.id} className="hover:bg-neutral-50 align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {fullName ?? <span className="text-neutral-400">(no name)</span>}
                    </div>
                    <div className="font-mono text-xs text-neutral-600">
                      {l.email ?? l.phone_e164 ?? '—'}
                    </div>
                    <div className="text-xs text-neutral-500">
                      {l.company ?? ''}
                      {l.company && l.city ? ' · ' : ''}
                      {l.city ? `${l.city}${l.region ? `, ${l.region}` : ''}` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <QualityScore value={l.quality_score} />
                  </td>
                  <td className="px-4 py-3">
                    <SourceTierBadge tier={l.source_tier} />
                  </td>
                  <td className="px-4 py-3">
                    <EligibilityPill value={l.export_eligibility} />
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <ReasonCodeChips codes={l.reason_codes} limit={4} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {state !== 'rejected' && (
                        <button
                          disabled={busy === l.id}
                          onClick={() => act(l.id, 'approve')}
                          className="rounded-md bg-emerald-600 text-white px-2.5 py-1 text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
                        >
                          Approve
                        </button>
                      )}
                      {state === 'rejected' ? (
                        <button
                          disabled={busy === l.id}
                          onClick={() => act(l.id, 'requeue')}
                          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 disabled:opacity-50"
                        >
                          Requeue
                        </button>
                      ) : (
                        <button
                          disabled={busy === l.id}
                          onClick={() => act(l.id, 'reject')}
                          className="rounded-md border border-red-300 text-red-700 px-2.5 py-1 text-xs font-medium hover:bg-red-50 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
