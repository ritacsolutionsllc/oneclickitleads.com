import { createClient } from '@/utils/supabase/server';
import { Suspense } from 'react';
import ScrapeForm from '@/components/ScrapeForm';
import Link from 'next/link';

export default async function ScrapePage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients')
    .select('id, slug, name, plan')
    .eq('owner_user', user.id)
    .order('created_at');

  if (!clients?.length) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
        <div className="text-lg font-medium">No clients yet</div>
        <div className="mt-2 text-sm text-neutral-600">
          Create a client first, then come back to scrape leads.
        </div>
      </div>
    );
  }

  const active = clients.find((c) => c.slug === sp.client) ?? clients[0];

  const { data: recentRuns } = await supabase
    .from('scrape_runs')
    .select('id, source, result, status, error_msg, created_at')
    .eq('client_id', active.id)
    .order('created_at', { ascending: false })
    .limit(20);

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Scrape</h1>
          <p className="text-sm text-neutral-600 mt-1">
            Pull fresh leads from public sources and enrich existing ones.
            Results land in{' '}
            <Link href="/dashboard/leads" className="text-emerald-700 hover:underline">
              Leads
            </Link>{' '}
            after scrubbing.
          </p>
        </div>
      </div>

      {/* Env var status hints */}
      <div className="mt-4 rounded-xl border border-neutral-200 bg-white p-4 text-xs text-neutral-500 flex flex-wrap gap-x-6 gap-y-1">
        <span>
          <span className="font-medium text-neutral-700">OpenStreetMap</span> — free, no key needed
        </span>
        <span>
          <span className="font-medium text-neutral-700">Google Places</span> — needs{' '}
          <code className="font-mono bg-neutral-100 px-1 rounded">GOOGLE_PLACES_API_KEY</code>
        </span>
        <span>
          <span className="font-medium text-neutral-700">Harvest Emails</span> — needs{' '}
          <code className="font-mono bg-neutral-100 px-1 rounded">INGEST_SECRET</code>
        </span>
        <span>
          <span className="font-medium text-neutral-700">Enrich</span> — needs{' '}
          <code className="font-mono bg-neutral-100 px-1 rounded">HUNTER_API_KEY</code>
        </span>
      </div>

      <div className="mt-6">
        <Suspense
          fallback={<div className="h-64 rounded-xl border border-neutral-200 bg-white animate-pulse" />}
        >
          <ScrapeForm clients={clients} />
        </Suspense>
      </div>

      {/* Run history */}
      {recentRuns && recentRuns.length > 0 && (
        <div className="mt-10">
          <h2 className="text-lg font-semibold mb-4">Run history</h2>
          <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="text-left px-4 py-3">When</th>
                  <th className="text-left px-4 py-3">Source</th>
                  <th className="text-left px-4 py-3">Result</th>
                  <th className="text-left px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {(recentRuns ?? []).map((run: any) => {
                  const r = run.result ?? {};
                  const summary = [
                    r.inserted != null && `${r.inserted} inserted`,
                    r.ingested != null && `${r.ingested} ingested`,
                    r.clean != null && `${r.clean} clean`,
                    r.enriched != null && `${r.enriched} enriched`,
                    r.updated != null && `${r.updated} updated`,
                    r.processed != null && `${r.processed} processed`,
                    r.skipped != null && `${r.skipped} skipped`,
                  ].filter(Boolean).join(' · ');
                  return (
                    <tr key={run.id} className="hover:bg-neutral-50">
                      <td className="px-4 py-3 text-neutral-600 whitespace-nowrap">
                        {new Date(run.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-medium capitalize">{run.source}</td>
                      <td className="px-4 py-3 text-neutral-600">{summary || '—'}</td>
                      <td className="px-4 py-3">
                        {run.status === 'ok' ? (
                          <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs">ok</span>
                        ) : (
                          <span className="rounded-full bg-red-50 text-red-800 px-2 py-0.5 text-xs" title={run.error_msg ?? ''}>error</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
