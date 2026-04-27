import { createClient } from '@/utils/supabase/server';
import { Suspense } from 'react';
import { planByTier } from '@/lib/plans';
import ScrapeForm from '@/components/ScrapeForm';
import Link from 'next/link';

type SP = { searchParams: Promise<{ client?: string }> };

export default async function ScrapePage({ searchParams }: SP) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients')
    .select('id, slug, name, plan')
    .eq('owner_user', user.id)
    .order('created_at');

  const active = (clients ?? []).find((c) => c.slug === sp.client) ?? clients?.[0];
  if (!active) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
        <div className="text-lg font-medium">No clients yet</div>
        <div className="mt-2 text-sm text-neutral-600">
          Create a client first, then come back to scrape leads.
        </div>
      </div>
    );
  }

  const plan = planByTier(active.plan);
  const canCustomScrape = plan.features.customScrapes;

  // Inventory count for starter/growth users
  let inventoryCount = 0;
  if (!canCustomScrape) {
    const { count } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('is_inventory', true);
    inventoryCount = count ?? 0;
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-semibold">Scrape</h1>
        <p className="text-sm text-neutral-500 mt-1">
          {canCustomScrape
            ? 'Run custom scrapes for any city, query, or industry. Results land in Leads after scrubbing.'
            : 'Your plan includes access to our pre-scraped US beauty database, updated nightly.'}
        </p>
      </div>

      {canCustomScrape ? (
        <>
          {/* Env var hints */}
          <div className="mb-5 rounded-xl border border-neutral-200 bg-white p-4 text-xs text-neutral-500 flex flex-wrap gap-x-6 gap-y-1">
            <span>
              <span className="font-medium text-neutral-700">Google Places</span>{' '}
              needs <code className="font-mono bg-neutral-100 px-1 rounded">GOOGLE_PLACES_API_KEY</code>
            </span>
            <span>
              <span className="font-medium text-neutral-700">Harvest Emails</span>{' '}
              uses built-in crawler (no extra key needed)
            </span>
            <span>
              <span className="font-medium text-neutral-700">Enrich</span>{' '}
              needs <code className="font-mono bg-neutral-100 px-1 rounded">HUNTER_API_KEY</code>
            </span>
          </div>

          <Suspense
            fallback={<div className="h-64 rounded-xl border border-neutral-200 bg-white animate-pulse" />}
          >
            <ScrapeForm clients={clients ?? []} activeSlug={active.slug} />
          </Suspense>
        </>
      ) : (
        /* ── Inventory mode for starter / growth ── */
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-xl border border-neutral-200 bg-white p-5">
              <p className="text-xs uppercase tracking-wider text-neutral-500">Leads in database</p>
              <p className="mt-1 text-3xl font-bold text-neutral-900">{inventoryCount.toLocaleString()}</p>
            </div>
            <div className="rounded-xl border border-neutral-200 bg-white p-5">
              <p className="text-xs uppercase tracking-wider text-neutral-500">Cities covered</p>
              <p className="mt-1 text-3xl font-bold text-neutral-900">50+</p>
            </div>
            <div className="rounded-xl border border-neutral-200 bg-white p-5">
              <p className="text-xs uppercase tracking-wider text-neutral-500">Updated</p>
              <p className="mt-1 text-3xl font-bold text-neutral-900">Nightly</p>
            </div>
          </div>

          <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
            <h2 className="text-lg font-semibold text-neutral-800">Pre-Scraped US Database</h2>
            <p className="mt-2 text-sm text-neutral-500 max-w-lg mx-auto">
              Salons, medspas, fitness studios, restaurants, retailers, and more — across 50+ US
              cities, scraped and scrubbed nightly. Your {plan.name} plan gives you up to{' '}
              <strong>{plan.features.monthlyCleanLeads.toLocaleString()} leads/month</strong>.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                href={`/dashboard/leads?client=${active.slug}`}
                className="rounded-full bg-emerald-600 text-white px-6 py-2.5 text-sm font-medium hover:bg-emerald-700"
              >
                Browse Leads →
              </Link>
              <Link
                href="/pricing"
                className="rounded-full border border-neutral-300 px-6 py-2.5 text-sm font-medium hover:bg-neutral-50"
              >
                Upgrade for Custom Scraping
              </Link>
            </div>
            <p className="mt-4 text-xs text-neutral-400">
              Custom city/industry scraping available on Agency ($499/mo) and above.
            </p>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-white p-6">
            <h3 className="font-semibold text-neutral-800 mb-4">Industries in the database</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm text-neutral-600">
              {[
                'Hair salons', 'Nail salons', 'Brow & lash bars',
                'Medspas', 'Skincare studios', 'Beauty retailers',
                'Gyms & fitness studios', 'Yoga & pilates', 'Wellness spas',
                'Restaurants & cafes', 'Boutique retail', 'Home services',
              ].map((item) => (
                <div key={item} className="flex items-center gap-2 rounded-lg bg-neutral-50 px-3 py-2">
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
