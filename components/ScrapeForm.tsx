'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

type Client = { id: string; name: string; slug: string; plan: string };
type Source = 'osm' | 'places' | 'harvest' | 'enrich' | 'rescrub';

const SOURCES: {
  key: Source;
  label: string;
  badge: string;
  description: string;
}[] = [
  {
    key: 'osm',
    label: 'OpenStreetMap',
    badge: 'free',
    description:
      'Finds beauty/salon businesses tagged in OSM by city — no API key needed. Good for long-tail SMBs that Google doesn\'t surface.',
  },
  {
    key: 'places',
    label: 'Google Places',
    badge: 'GOOGLE_PLACES_API_KEY',
    description:
      'Text-search Google Places and pull phone, website, and address in one round-trip. Up to 60 results per query.',
  },
  {
    key: 'harvest',
    label: 'Harvest Emails',
    badge: 'free',
    description:
      'Crawl existing leads\' websites for contact emails — catches long-tail salons whose emails aren\'t in Hunter.',
  },
  {
    key: 'enrich',
    label: 'Enrich via Hunter',
    badge: 'HUNTER_API_KEY',
    description:
      'For leads that have a website but no email, query Hunter.io domain search and write the top verified result back.',
  },
  {
    key: 'rescrub',
    label: 'Scrub List',
    badge: 'free',
    description:
      'Validate emails, deduplicate, score, and tier all pending leads — run this after harvesting to make leads exportable.',
  },
];

const SEGMENTS = ['salon', 'b2c_beauty', 'influencer', 'retailer'] as const;
const OSM_SHOPS = ['beauty', 'hairdresser', 'cosmetics', 'massage', 'optician'];

export default function ScrapeForm({ clients }: { clients: Client[] }) {
  const searchParams = useSearchParams();
  const activeSlug = searchParams.get('client') ?? clients[0]?.slug ?? '';
  const activeClient = clients.find((c) => c.slug === activeSlug) ?? clients[0];

  const [source, setSource] = useState<Source>('osm');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // OSM
  const [shop, setShop] = useState('beauty');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [segment, setSegment] = useState<string>('salon');

  // Places
  const [query, setQuery] = useState('');

  // Harvest
  const [limit, setLimit] = useState(50);

  // Enrich
  const [batchSize, setBatchSize] = useState(100);

  function switchSource(s: Source) {
    setSource(s);
    setResult(null);
    setError(null);
  }

  async function run() {
    setRunning(true);
    setResult(null);
    setError(null);

    const body: Record<string, unknown> = {
      source,
      client_slug: activeClient?.slug ?? activeSlug,
    };
    if (source === 'osm') Object.assign(body, { shop, city, region, segment });
    if (source === 'places') Object.assign(body, { query, segment });
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
            <div className="flex items-start justify-between gap-2">
              <div className="font-medium text-sm">{s.label}</div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  s.badge === 'free'
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-50 text-amber-800'
                }`}
              >
                {s.badge === 'free' ? 'free' : 'key req.'}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-neutral-500 leading-relaxed line-clamp-2">
              {s.description}
            </p>
          </button>
        ))}
      </div>

      {/* Config form */}
      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="font-medium">{SOURCES.find((s) => s.key === source)?.label}</div>
            <div className="text-xs text-neutral-500 mt-0.5">
              Target: <strong>{activeClient?.name ?? activeSlug}</strong>
            </div>
          </div>
        </div>

        <div className="grid gap-4 max-w-lg">
          {source === 'osm' && (
            <>
              <Field label="Shop type">
                <select
                  className={inp}
                  value={shop}
                  onChange={(e) => setShop(e.target.value)}
                >
                  {OSM_SHOPS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="City">
                  <input
                    className={inp}
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Los Angeles"
                  />
                </Field>
                <Field label="State / Region">
                  <input
                    className={inp}
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="CA"
                  />
                </Field>
              </div>
              <SegmentField value={segment} onChange={setSegment} />
            </>
          )}

          {source === 'places' && (
            <>
              <Field label="Search query" hint="e.g. eyebrow salon Los Angeles CA">
                <input
                  className={inp}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="eyebrow salon Los Angeles CA"
                />
              </Field>
              <SegmentField value={segment} onChange={setSegment} />
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
                Picks up leads that have an email but are still marked <em>pending</em> — validates emails, removes
                duplicates, scores each lead, and assigns an export tier so they appear in CSV exports.
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
              `Run ${SOURCES.find((s) => s.key === source)?.label}`
            )}
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-5">
          <div className="font-medium text-emerald-900 mb-3">Complete</div>
          <div className="grid sm:grid-cols-3 gap-3 mb-4">
            {(['inserted', 'skipped', 'errors', 'processed', 'clean', 'rejected'] as const).map((k) =>
              result[k] != null ? (
                <div key={k} className="rounded-lg bg-white border border-emerald-200 p-3 text-center">
                  <div className="text-2xl font-semibold text-emerald-800">{String(result[k])}</div>
                  <div className="text-xs text-neutral-500 capitalize mt-0.5">{k}</div>
                </div>
              ) : null,
            )}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-emerald-700 hover:underline">
              Raw response
            </summary>
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

function SegmentField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
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
