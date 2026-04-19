'use client';

import { useRef, useState } from 'react';

type Summary = {
  ingested: number;
  eligible: number;
  review: number;
  quarantine: number;
  rejected: number;
  mapping: Record<string, string | undefined>;
  source_id?: string;
};

export default function VerifyClient({
  clients,
  defaultSlug,
}: {
  clients: { slug: string; name: string }[];
  defaultSlug: string;
}) {
  const [slug, setSlug] = useState(defaultSlug);
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setSummary(null);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('client_slug', slug);
    if (label) fd.append('source_label', label);

    try {
      const res = await fetch('/api/verify-csv', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function downloadClean() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('client_slug', slug);
    if (label) fd.append('source_label', label);

    try {
      const res = await fetch('/api/verify-csv?format=csv', { method: 'POST', body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-verified-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'download failed');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setSummary(null);
    setError(null);
    formRef.current?.reset();
  }

  return (
    <div className="mt-6 space-y-6">
      <form
        ref={formRef}
        onSubmit={upload}
        className="rounded-xl border border-neutral-200 bg-white p-6 space-y-4"
      >
        <div className="grid md:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-500">Client</span>
            <select
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              disabled={busy}
            >
              {clients.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name} ({c.slug})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-500">Source label (optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Q2 trade show leads"
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              disabled={busy}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs uppercase tracking-wider text-neutral-500">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-emerald-600 file:px-4 file:py-2 file:text-white hover:file:bg-emerald-700"
            disabled={busy}
            required
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Up to 10,000 rows · 10 MB max · we auto-detect email/phone/name columns
          </span>
        </label>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={!file || busy}
            className="rounded-full bg-emerald-600 text-white px-5 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? 'Scrubbing…' : 'Scrub + ingest'}
          </button>
          <button
            type="button"
            onClick={downloadClean}
            disabled={!file || busy}
            className="rounded-full border border-neutral-300 px-5 py-2 text-sm font-medium hover:bg-neutral-100 disabled:opacity-50"
          >
            Download cleaned CSV
          </button>
          {(file || summary) && (
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="rounded-full px-3 py-2 text-sm text-neutral-500 hover:text-neutral-900 disabled:opacity-50"
            >
              Reset
            </button>
          )}
        </div>
      </form>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 text-red-800 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {summary && (
        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="font-medium">Scrub complete</div>
              <div className="text-sm text-neutral-600">
                {summary.ingested.toLocaleString()} rows ingested into the {slug} tenant.
              </div>
            </div>
            <a
              href={`/dashboard/quality?client=${slug}`}
              className="text-sm text-emerald-700 hover:underline"
            >
              View in review queue →
            </a>
          </div>

          <div className="mt-4 grid md:grid-cols-4 gap-3">
            <Stat label="Eligible"   value={summary.eligible}   color="emerald" />
            <Stat label="In review"  value={summary.review}     color="amber" />
            <Stat label="Quarantine" value={summary.quarantine} color="orange" />
            <Stat label="Rejected"   value={summary.rejected}   color="red" />
          </div>

          <div className="mt-6 text-xs text-neutral-500">
            <div className="font-medium text-neutral-700 mb-1">Column mapping</div>
            <ul className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
              {Object.entries(summary.mapping).map(([k, v]) => (
                <li key={k}>
                  <span className="font-mono">{k}</span>
                  <span className="mx-1">→</span>
                  {v ? (
                    <span className="font-mono text-neutral-700">{v}</span>
                  ) : (
                    <span className="text-neutral-400">—</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: 'emerald' | 'amber' | 'orange' | 'red';
}) {
  const cls = {
    emerald: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    amber:   'border-amber-300   bg-amber-50   text-amber-900',
    orange:  'border-orange-300  bg-orange-50  text-orange-900',
    red:     'border-red-300     bg-red-50     text-red-900',
  }[color];
  return (
    <div className={`rounded-lg border px-4 py-3 ${cls}`}>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-2xl font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}
