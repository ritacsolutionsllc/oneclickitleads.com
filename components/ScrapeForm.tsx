'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

type Client = { id: string; name: string; slug: string; plan: string };
type Source = 'places' | 'harvest' | 'enrich' | 'rescrub';

const SOURCES: { key: Source; label: string; description: string; envHint?: string }[] = [
  {
    key: 'places',
    label: 'Google Places',
    description: 'Search Google Places for beauty businesses by city or query. Up to 60 results per run.',
    envHint: 'GOOGLE_PLACES_API_KEY',
  },
  {
    key: 'harvest',
    label: 'Harvest Emails',
    description: "Crawl existing leads' websites for contact emails — catches long-tail businesses not in Hunter.",
    envHint: 'INGEST_SECRET',
  },
  {
    key: 'enrich',
    label: 'Enrich via Hunter',
    description: 'For leads with a website but no email, query Hunter.io domain search and write the top verified result back.',
    envHint: 'HUNTER_API_KEY + INGEST_SECRET',
  },
  {
    key: 'rescrub',
    label: 'Scrub List',
    description: 'Validate emails, deduplicate, score, and tier all pending leads — run after harvesting to make leads exportable.',
  },
];

// Quick-start query presets for beauty ICP
const BEAUTY_PRESETS: { label: string; query: string }[] = [
  { label: 'Hair salons', query: 'hair salon' },
  { label: 'Nail salons', query: 'nail salon' },
  { label: 'Brow & lash bars', query: 'brow bar lash studio' },
  { label: 'Medspas', query: 'medspa medical spa' },
  { label: 'Skincare studios', query: 'skincare studio esthetician' },
  { label: 'Beauty supply', query: 'beauty supply store' },
  { label: 'Makeup artists', query: 'makeup artist studio' },
  { label: 'Massage & wellness', query: 'massage spa wellness center' },
  { label: 'Barbershops', query: 'barbershop barber' },
  { label: 'Cosmetics retail', query: 'cosmetics beauty retailer' },
];

const SEGMENTS = ['salon', 'b2c_beauty', 'influencer', 'retailer'] as const;

export default function ScrapeForm({
  clients,
  activeSlug: activeSlugProp,
}: {
  clients: Client[];
  activeSlug?: string;
}) {
  const searchParams = useSearchParams();
  const activeSlug = activeSlugProp ?? searchParams.get('client') ?? clients[0]?.slug ?? '';
  const activeClient = clients.find((c) => c.slug === activeSlug) ?? clients[0];

  const [source, setSource] = useState<Source>('places');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Places
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');
  const [segment, setSegment] = useState<string>('salon');

  // Harvest / Rescrub
  const [limit, setLimit] = useState(50);

  // Enrich
  const [batchSize, setBatchSize] = useState(100);

  function switchSource(s: Source) {
    setSource(s);
    setResult(null);
    setError(null);
  }

  function applyPreset(preset: { query: string }) {
    setQuery(city ? `${preset.query} ${city}` : preset.query);
  }

  async function run() {
    setRunning(true);
    setResult(null);
    setError(null);

    const slug = activeClient?.slug ?? activeSlug;
    const body: Record<string, unknown> = { source, client_slug: slug };

    if (source === 'places') {
      const q = city ? `${query} ${city}`.trim() : query.trim();
      if (!q) { setError('Enter a search query or pick a preset.'); setRunning(false); return; }
      Object.assign(body, { query: q, segment });
    }
    if (source === 'harvest') Object.assign(body, { limit });
    if (source === 'enrich') Object.assign(body, { batch_size: batchSize });
    if (source === 'rescrub') Object.assign(body, { limit });

    try {
      const res = await fetch('/api/dashboard/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Unknown error');
      else setResult(data);
    } catch {
      setError('Request failed — check your network and try again.');
    } finally {
      setRunning(false);
    }
  }

  const activeSource = SOURCES.find((s) => s.key === source)!;

  return (
    <div className="space-y-6">
      {/* Source selector */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {SOURCES.map((s) => (
          <button
            key={s.key}
            onClick={() => switchSource(s.key)}
            className={`rounded-xl border p-4 text-left transition ${
              source === s.key
                ? 'border-emerald-500 bg-emerald-50'
                : 'border-neutral-200 bg-white hover:border-neutral-300'
            }`}
          >
            <div className="font-medium text-sm">{s.label}</div>
            {s.envHint && (
              <div className="mt-0.5 text-xs text-amber-700 font-mono">{s.envHint}</div>
            )}
            <p className="mt-1.5 text-xs text-neutral-500 leading-relaxed line-clamp-2">
              {s.description}
            </p>
          </button>
        ))}
      </div>

      {/* Config form */}
      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <div className="mb-5">
          <div className="font-medium">{activeSource.label}</div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Target: <strong>{activeClient?.name ?? activeSlug}</strong>
          </div>
        </div>

        <div className="grid gap-4 max-w-xl">
          {source === 'places' && (
            <>
              {/* Category presets */}
              <div>
                <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2">
                  Quick presets
                </div>
                <div className="flex flex-wrap gap-2">
                  {BEAUTY_PRESETS.map((p) => (
                    <button
                      key={p.query}
                      type="button"
                      onClick={() => applyPreset(p)}
                      className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-800 transition"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Business type / query" hint="e.g. nail salon, medspa">
                  <input
                    className={inp}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="nail salon"
                  />
                </Field>
                <Field label="City" hint="e.g. Los Angeles CA">
                  <input
                    className={inp}
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Los Angeles CA"
                  />
                </Field>
              </div>
              <SegmentField value={segment} onChange={setSegment} />
              {query && (
                <p className="text-xs text-neutral-400">
                  Will search: <em>&quot;{city ? `${query} ${city}` : query}&quot;</em> — up to 60 results
                </p>
              )}
            </>
          )}

          {source === 'harvest' && (
            <Field label="Max leads to crawl" hint="1 – 200">
              <input
                type="number"
                min={1}
                max={200}
                className={inp}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
            </Field>
          )}

          {source === 'enrich' && (
            <Field label="Batch size" hint="1 – 200">
              <input
                type="number"
                min={1}
                max={200}
                className={inp}
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
              />
            </Field>
          )}

          {source === 'rescrub' && (
            <>
              <Field label="Max leads to scrub" hint="1 – 500">
                <input
                  type="number"
                  min={1}
                  max={500}
                  className={inp}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </Field>
              <p className="text-xs text-neutral-500 leading-relaxed">
                Picks up leads that have an email but are still marked <em>pending</em> — validates,
                deduplicates, scores, and assigns an export tier so they appear in CSV exports.
              </p>
            </>
          )}

          <button
            onClick={run}
            disabled={running}
            className="mt-1 w-fit rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {running ? (
              <span className="flex items-center gap-2">
                <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                Running…
              </span>
            ) : (
              `Run ${activeSource.label}`
            )}
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-5">
          <div className="font-medium text-emerald-900 mb-3">Complete</div>
          <div className="grid sm:grid-cols-3 gap-3 mb-4">
            {(
              ['fetched', 'ingested', 'inserted', 'clean', 'enriched', 'updated', 'processed', 'checked', 'skipped', 'rejected'] as const
            ).map((k) =>
              (result as Record<string, unknown>)[k] != null ? (
                <div key={k} className="rounded-lg bg-white border border-emerald-200 p-3 text-center">
                  <div className="text-2xl font-semibold text-emerald-800">
                    {String((result as Record<string, unknown>)[k])}
                  </div>
                  <div className="text-xs text-neutral-500 capitalize mt-0.5">{k}</div>
                </div>
              ) : null,
            )}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-emerald-700 hover:underline">Raw response</summary>
            <pre className="mt-2 overflow-auto rounded bg-white border border-emerald-200 p-3 text-neutral-700">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}

const inp =
  'rounded-lg border border-neutral-300 px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-emerald-500';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
        {label}
        {hint && <span className="ml-1 normal-case font-normal text-neutral-400">— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

function SegmentField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="ICP Segment">
      <select className={inp} value={value} onChange={(e) => onChange(e.target.value)}>
        {SEGMENTS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </Field>
  );
}
