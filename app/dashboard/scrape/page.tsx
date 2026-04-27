import { Suspense } from 'react';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/server';
import ScrapeForm from '@/components/ScrapeForm';

type SP = { searchParams: { client?: string } };

export default async function ScrapePage({ searchParams }: SP) {
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

  const active = (clients ?? []).find((c) => c.slug === searchParams.client) ?? clients?.[0];
  if (!active) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
        <div className="text-lg font-medium">No clients yet</div>
        <div className="mt-2 text-sm text-neutral-600">Create a client first, then run your first scrape.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Scrape</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Run Google Places, enrich emails, and rescrub records before exporting.
          </p>
        </div>
        <Link
          href={`/dashboard/leads?client=${active.slug}`}
          className="rounded-full border border-neutral-300 px-4 py-2 text-sm hover:bg-white"
        >
          View Leads
        </Link>
      </div>

      <Suspense fallback={<div className="h-64 animate-pulse rounded-xl border border-neutral-200 bg-white" />}>
        <ScrapeForm clients={clients ?? []} activeSlug={active.slug} />
      </Suspense>
    </div>
  );
}
