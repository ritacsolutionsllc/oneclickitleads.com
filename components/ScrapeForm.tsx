'use client';

import { useMemo, useState } from 'react';

type Client = { id: string; name: string; slug: string; plan: string };
type Source = 'places' | 'harvest' | 'enrich' | 'rescrub';

const SOURCES: { key: Source; label: string; help: string }[] = [
  { key: 'places', label: 'Google Places', help: 'Pull businesses by query and city.' },
  { key: 'harvest', label: 'Harvest Emails', help: 'Crawl websites for contact emails.' },
  { key: 'enrich', label: 'Enrich (Hunter)', help: 'Fill missing emails from domains.' },
  { key: 'rescrub', label: 'Rescrub', help: 'Re-run scrub scoring and status.' },
];

const SEGMENTS = [
  'salon',
  'b2c_beauty',
  'influencer',
  'retailer',
  'medspa',
  'wellness',
  'fitness',
  'healthcare',
  'pharmacy',
  'retail',
  'ecommerce',
  'restaurant',
  'food_truck',
  'hospitality',
  'real_estate',
  'professional_services',
  'marketing_agency',
  'home_services',
  'automotive',
  'education',
  'tech',
  'nonprofit',
] as const;

const PRESETS = [
  { label: 'Hair salons', query: 'hair salon Los Angeles CA', segment: 'salon' },
  { label: 'Nail salons', query: 'nail salon Miami FL', segment: 'salon' },
  { label: 'Brow + lash', query: 'brow bar lash studio Dallas TX', segment: 'salon' },
  { label: 'Medspas', query: 'medspa Scottsdale AZ', segment: 'medspa' },
  { label: 'Fitness', query: 'fitness studio Austin TX', segment: 'fitness' },
  { label: 'Restaurants', query: 'restaurant Chicago IL', segment: 'restaurant' },
] as const;

export default function ScrapeForm({ clients, activeSlug }: { clients: Client[]; activeSlug?: string }) {
  const active = useMemo(() => {
    if (activeSlug) {
      const hit = clients.find((c) => c.slug === activeSlug);
      if (hit) return hit;
    }
    return clients[0];
  }, [activeSlug, clients]);

  const [source, setSource] = useState<Source>('places');
  const [query, setQuery] = useState<string>(PRESETS[0].query);
  const [segment, setSegment] = useState<string>('salon');
  const [limit, setLimit] = useState(50);
  const [batchSize, setBatchSize] = useState(100);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!active?.slug) return;
    setRunning(true);
    setError(null);
    setResult(null);

    const payload: Record<string, unknown> = {
      source,
      client_slug: active.slug,
    };

    if (source === 'places') Object.assign(payload, { query: query.trim(), segment });
    if (source === 'harvest' || source === 'rescrub') Object.assign(payload, { limit });
    if (source === 'enrich') Object.assign(payload, { batch_size: batchSize });

    try {
      const resp = await fetch('/api/dashboard/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      if (!resp.ok) {
        setError(String(data.error ?? 'Request failed'));
      } else {
        setResult(data);
      }
    } catch {
      setError('Network error while running scraper');
    } finally {
      setRunning(false);
    }
  }

  function applyPreset(queryPreset: string, segmentPreset: string) {
    setQuery(queryPreset);
    setSegment(segmentPreset);
    setSource('places');
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {SOURCES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSource(s.key)}
            className={`rounded-xl border p-4 text-left ${source === s.key ? 'border-emerald-500 bg-emerald-50' : 'border-neutral-200 bg-white hover:border-neutral-300'}`}
          >
            <div className="text-sm font-medium">{s.label}</div>
            <div className="mt-1 text-xs text-neutral-500">{s.help}</div>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="mb-4 text-sm text-neutral-600">
          Target client: <span className="font-medium text-neutral-900">{active?.name ?? 'Unknown'}</span>
        </div>

        {source === 'places' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p.query, p.segment)}
                  className="rounded-full border border-neutral-200 px-3 py-1 text-xs hover:border-emerald-400 hover:bg-emerald-50"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="hair salon Los Angeles CA"
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            />
            <select
              value={segment}
              onChange={(e) => setSegment(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            >
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}

        {source === 'harvest' && (
          <input
            type="number"
            min={1}
            max={200}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
        )}

        {source === 'enrich' && (
          <input
            type="number"
            min={1}
            max={200}
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value))}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
        )}

        {source === 'rescrub' && (
          <input
            type="number"
            min={1}
            max={500}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
        )}

        <button
          type="button"
          disabled={running}
          onClick={run}
          className="mt-4 rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {running ? 'Running...' : `Run ${SOURCES.find((s) => s.key === source)?.label}`}
        </button>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {result && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-sm font-medium text-emerald-900">Run complete</div>
          <pre className="mt-2 overflow-auto rounded border border-emerald-200 bg-white p-3 text-xs text-neutral-700">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
