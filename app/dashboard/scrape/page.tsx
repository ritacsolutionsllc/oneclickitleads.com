import { createClient } from '@/utils/supabase/server';
import { Suspense } from 'react';
import ScrapeForm from '@/components/ScrapeForm';
import Link from 'next/link';

export default async function ScrapePage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
          <code className="font-mono bg-neutral-100 px-1 rounded">GOOGLE_PLACES_API_KEY</code> in Vercel
        </span>
        <span>
          <span className="font-medium text-neutral-700">Harvest Emails</span> — needs{' '}
          <code className="font-mono bg-neutral-100 px-1 rounded">INGEST_SECRET</code> in Vercel
        </span>
        <span>
          <span className="font-medium text-neutral-700">Enrich</span> — needs{' '}
          <code className="font-mono bg-neutral-100 px-1 rounded">HUNTER_API_KEY</code> +{' '}
          <code className="font-mono bg-neutral-100 px-1 rounded">INGEST_SECRET</code>
        </span>
      </div>

      <div className="mt-6">
        <Suspense
          fallback={
            <div className="h-64 rounded-xl border border-neutral-200 bg-white animate-pulse" />
          }
        >
          <ScrapeForm clients={clients} />
        </Suspense>
      </div>
    </div>
  );
}
