'use client';

import { useState } from 'react';

/**
 * Form that calls /api/push/smartly for the given client.
 * Shown on /dashboard/leads — handles segment + min-score filter.
 */
export default function PushToSmartlyForm({ clientSlug }: { clientSlug: string }) {
  const [segment, setSegment] = useState<string>('');
  const [minScore, setMinScore] = useState(60);
  const [audienceName, setAudienceName] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function push() {
    setRunning(true);
    setResult(null);
    try {
      // Calls the dashboard proxy which injects INGEST_SECRET + verifies
      // ownership before hitting the S2S push endpoint.
      const res = await fetch('/api/dashboard/push-smartly', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_slug: clientSlug,
          segment: segment || undefined,
          min_score: minScore,
          audience_name: audienceName || undefined,
        }),
      });
      setResult(await res.json());
    } catch (err) {
      setResult({ error: String(err) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="font-medium">Push to smartly.io</div>
        <div className="text-xs text-neutral-500">Hashed + synced as a Custom Audience</div>
      </div>

      <div className="mt-4 grid md:grid-cols-3 gap-3">
        <label className="text-sm">
          <div className="text-xs text-neutral-600 mb-1">ICP segment</div>
          <select
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          >
            <option value="">All</option>
            <option value="b2c_beauty">b2c_beauty</option>
            <option value="salon">salon</option>
            <option value="influencer">influencer</option>
            <option value="retailer">retailer</option>
          </select>
        </label>

        <label className="text-sm">
          <div className="text-xs text-neutral-600 mb-1">Min scrub score</div>
          <input
            type="number"
            min={0}
            max={100}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
        </label>

        <label className="text-sm">
          <div className="text-xs text-neutral-600 mb-1">Audience name</div>
          <input
            type="text"
            placeholder={`${clientSlug} — ${new Date().toISOString().slice(0, 10)}`}
            value={audienceName}
            onChange={(e) => setAudienceName(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
        </label>
      </div>

      <button
        onClick={push}
        disabled={running}
        className="mt-4 rounded-full bg-emerald-600 text-white px-5 py-2 font-medium hover:bg-emerald-700 disabled:opacity-50"
      >
        {running ? 'Pushing…' : 'Push audience'}
      </button>

      {result && (
        <pre className="mt-4 rounded-lg bg-neutral-900 text-neutral-100 text-xs p-4 overflow-auto">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
