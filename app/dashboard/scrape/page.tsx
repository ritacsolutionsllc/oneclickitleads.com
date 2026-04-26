import { createClient } from '@/utils/supabase/server';
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
    .eq('owner_user', user.id);

  const active = (clients ?? []).find((c) => c.slug === sp.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const plan = planByTier(active.plan);
  const canCustomScrape = plan.features.customScrapes;

  // ── Inventory stats for starter/growth users ──────────────────────────────
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
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Scrape</h1>
        <p className="text-sm text-neutral-500 mt-1">
          {canCustomScrape
            ? 'Run custom scrapes for any city, query, or niche.'
            : 'Your plan includes access to our pre-scraped US beauty database, updated nightly.'}
        </p>
      </div>

      {canCustomScrape ? (
        <ScrapeForm clients={clients ?? []} activeSlug={active.slug} />
      ) : (
        /* ── Inventory mode for starter / growth ── */
        <div className="space-y-6">
          {/* Stats banner */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-xl border border-neutral-200 bg-white p-5">
              <p className="text-xs uppercase tracking-wider text-neutral-500">Leads in database</p>
              <p className="mt-1 text-3xl font-bold text-neutral-900">
                {inventoryCount.toLocaleString()}
              </p>
            </div>
            <div className="rounded-xl border border-neutral-200 bg-white p-5">
              <p className="text-xs uppercase tracking-wider text-neutral-500">Cities covered</p>
              <p className="mt-1 text-3xl font-bold text-neutral-900">50</p>
            </div>
            <div className="rounded-xl border border-neutral-200 bg-white p-5">
              <p className="text-xs uppercase tracking-wider text-neutral-500">Updated</p>
              <p className="mt-1 text-3xl font-bold text-neutral-900">Nightly</p>
            </div>
          </div>

          {/* CTA card */}
          <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50">
              <span className="text-2xl">💄</span>
            </div>
            <h2 className="text-lg font-semibold text-neutral-800">
              Pre-Scraped US Beauty Database
            </h2>
            <p className="mt-2 text-sm text-neutral-500 max-w-lg mx-auto">
              Salons, brow bars, medspas, nail studios, beauty retailers, and more —
              across 50+ US cities, scraped and scrubbed nightly.
              Your {plan.name} plan gives you up to{' '}
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
              Custom city/niche scraping available on Agency ($499/mo) and above.
            </p>
          </div>

          {/* What's in the database */}
          <div className="rounded-xl border border-neutral-200 bg-white p-6">
            <h3 className="font-semibold text-neutral-800 mb-4">What's in the database</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm text-neutral-600">
              {[
                '💅 Nail salons',
                '💆 Hair salons',
                '👁️ Brow & lash bars',
                '🧴 Skincare studios',
                '💉 Medspas',
                '🛍️ Beauty retailers',
                '💄 Cosmetics stores',
                '🏥 Aesthetic clinics',
                '🌿 Clean beauty shops',
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
