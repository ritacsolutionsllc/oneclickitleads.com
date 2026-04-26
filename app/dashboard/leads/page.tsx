import { createClient } from '@/utils/supabase/server';
import { planByTier } from '@/lib/plans';
import Link from 'next/link';
import PushToSmartlyForm from '@/components/PushToSmartlyForm';

type SP = {
  searchParams: Promise<{
    client?: string;
    segment?: string;
    scrubbed?: string;
    tier?: string;
    page?: string;
    q?: string;
    minScore?: string;
    region?: string;
    mode?: string; // 'inventory' | 'mine'
  }>;
};

const PAGE_SIZE = 50;

const VALID_TIERS = ['premium', 'standard', 'prospecting', 'review', 'hold', 'discard'] as const;

export default async function LeadsPage({ searchParams }: SP) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients').select('id, slug, name, plan').eq('owner_user', user.id);
  const active = (clients ?? []).find((c) => c.slug === sp.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const plan = planByTier(active.plan);
  const canCustomScrape = plan.features.customScrapes;

  // Default: starter/growth see inventory; agency+ see their own leads
  const mode = sp.mode ?? (canCustomScrape ? 'mine' : 'inventory');

  const page = Math.max(1, Number(sp.page ?? 1));
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const tierFilter = sp.tier && (VALID_TIERS as readonly string[]).includes(sp.tier) ? sp.tier : null;

  let q = supabase
    .from('leads')
    .select(
      'id, first_name, last_name, email, phone_e164, company, title, city, region, icp_segment, scrub_score, composite_score, export_tier, is_scrubbed, reject_reason, website, rating, rating_count, created_at',
      { count: 'exact' }
    );

  if (mode === 'inventory') {
    q = q.eq('is_inventory', true);
  } else {
    q = q.eq('client_id', active.id).eq('is_inventory', false);
  }

  if (sp.segment) q = q.eq('icp_segment', sp.segment);
  if (sp.region)  q = q.eq('region', sp.region);
  if (sp.scrubbed === '1') q = q.eq('is_scrubbed', true);
  if (sp.scrubbed === '0') q = q.eq('is_scrubbed', false);
  if (tierFilter) q = q.eq('export_tier', tierFilter);
  if (sp.minScore) q = q.gte('composite_score', Number(sp.minScore));
  if (sp.q) {
    const term = sp.q;
    q = q.or(`email.ilike.%${term}%,company.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`);
  }

  const { data: leads, count } = await q
    .order('composite_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(from, to);

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const baseParams = new URLSearchParams();
  baseParams.set('client', active.slug);
  baseParams.set('mode', mode);
  if (sp.segment) baseParams.set('segment', sp.segment);
  if (sp.region)  baseParams.set('region', sp.region);
  if (sp.scrubbed) baseParams.set('scrubbed', sp.scrubbed);
  if (tierFilter) baseParams.set('tier', tierFilter);
  if (sp.minScore) baseParams.set('minScore', sp.minScore);
  if (sp.q) baseParams.set('q', sp.q);
  const pageLink = (p: number) => {
    const u = new URLSearchParams(baseParams);
    u.set('page', String(p));
    return `/dashboard/leads?${u.toString()}`;
  };

  const exportLink = `/api/export?client=${active.slug}&format=csv&mode=${mode}${
    sp.segment ? `&segment=${sp.segment}` : ''
  }${tierFilter ? `&tier=${tierFilter}` : ''}${sp.minScore ? `&min_score=${sp.minScore}` : ''}${
    sp.region ? `&region=${sp.region}` : ''
  }`;

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-neutral-600">
            {total.toLocaleString()} total · {active.name}
            {mode === 'inventory' && (
              <span className="ml-2 inline-flex items-center rounded-full bg-violet-100 text-violet-800 px-2 py-0.5 text-xs font-medium">
                US Beauty Inventory
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Mode toggle — only show if agency+ */}
          {canCustomScrape && (
            <div className="flex rounded-full border border-neutral-200 overflow-hidden text-sm">
              <Link
                href={`/dashboard/leads?client=${active.slug}&mode=mine`}
                className={`px-4 py-2 ${
                  mode === 'mine' ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-50'
                }`}
              >
                My Leads
              </Link>
              <Link
                href={`/dashboard/leads?client=${active.slug}&mode=inventory`}
                className={`px-4 py-2 ${
                  mode === 'inventory' ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-50'
                }`}
              >
                Beauty Inventory
              </Link>
            </div>
          )}

          {/* CSV export — paid plans only */}
          {plan.features.destinations.includes('csv') ? (
            <Link
              href={exportLink}
              className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700"
            >
              Export CSV
            </Link>
          ) : (
            <Link
              href="/pricing"
              className="rounded-full border border-neutral-300 px-4 py-2 text-sm text-neutral-500 hover:bg-neutral-50"
              title="Upgrade to export CSV"
            >
              🔒 Export CSV
            </Link>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <form method="get" className="mt-6 rounded-xl border border-neutral-200 bg-white p-4 grid md:grid-cols-7 gap-3">
        <input type="hidden" name="client" value={active.slug} />
        <input type="hidden" name="mode" value={mode} />
        <input
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="Search email, company, name"
          className="md:col-span-2 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        />
        <select name="segment" defaultValue={sp.segment ?? ''} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">
          <option value="">All segments</option>
          <option value="b2c_beauty">b2c_beauty</option>
          <option value="salon">salon</option>
          <option value="influencer">influencer</option>
          <option value="retailer">retailer</option>
        </select>
        <select name="region" defaultValue={sp.region ?? ''} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">
          <option value="">All states</option>
          {['CA','NY','FL','TX','IL','WA','GA','NC','CO','TN','OR','AZ','NV','MA','PA','OH','MN','MO','VA','IN','UT','LA','NE','NM','OK','ID','MS','MT','AK','HI'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select name="tier" defaultValue={tierFilter ?? ''} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">
          <option value="">All tiers</option>
          <option value="premium">Premium (≥80)</option>
          <option value="standard">Standard (65–79)</option>
          <option value="prospecting">Prospecting (50–64)</option>
          <option value="review">Review (35–49)</option>
          <option value="hold">Hold (20–34)</option>
          <option value="discard">Discard (&lt;20)</option>
        </select>
        <div className="flex gap-2">
          <input
            name="minScore"
            type="number"
            min={0}
            max={100}
            defaultValue={sp.minScore ?? ''}
            placeholder="Min score"
            className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg bg-neutral-900 text-white px-3 py-2 text-sm">Apply</button>
        </div>
      </form>

      {/* Lead table */}
      <div className="mt-6 rounded-xl border border-neutral-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-600 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-3">Company</th>
                <th className="text-left px-4 py-3">Email</th>
                <th className="text-left px-4 py-3">Phone</th>
                <th className="text-left px-4 py-3">City</th>
                <th className="text-left px-4 py-3">State</th>
                <th className="text-left px-4 py-3">Segment</th>
                <th className="text-left px-4 py-3">Score</th>
                <th className="text-left px-4 py-3">Tier</th>
                <th className="text-left px-4 py-3">Website</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(leads ?? []).map((l: any) => (
                <tr key={l.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3 font-medium">{l.company ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs">{l.email ?? <span className="text-neutral-300">no email</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs">{l.phone_e164 ?? '—'}</td>
                  <td className="px-4 py-3">{l.city ?? '—'}</td>
                  <td className="px-4 py-3">{l.region ?? '—'}</td>
                  <td className="px-4 py-3">
                    {l.icp_segment ? (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">{l.icp_segment}</span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {l.composite_score != null ? Math.round(Number(l.composite_score)) : (l.scrub_score ?? '—')}
                  </td>
                  <td className="px-4 py-3">
                    {l.export_tier ? (
                      <span className={tierBadgeClass(l.export_tier)}>{l.export_tier}</span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {l.website ? (
                      <a href={l.website} target="_blank" rel="noopener noreferrer"
                        className="text-sky-600 hover:underline text-xs truncate max-w-[140px] block">
                        {l.website.replace(/^https?:\/\//, '')}
                      </a>
                    ) : '—'}
                  </td>
                </tr>
              ))}
              {(!leads || leads.length === 0) && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <p className="text-neutral-500">No leads match these filters.</p>
                    {mode === 'mine' && (
                      <p className="mt-2 text-sm text-neutral-400">
                        Run a{' '}
                        <Link href={`/dashboard/scrape?client=${active.slug}`} className="text-emerald-600 hover:underline">
                          Scrape job
                        </Link>{' '}
                        first to populate your leads.
                      </p>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-neutral-600">
          <div>Page {page} of {totalPages}</div>
          <div className="flex gap-2">
            {page > 1 && <Link href={pageLink(page - 1)} className="rounded-lg border border-neutral-300 px-3 py-1 hover:bg-white">← Prev</Link>}
            {page < totalPages && <Link href={pageLink(page + 1)} className="rounded-lg border border-neutral-300 px-3 py-1 hover:bg-white">Next →</Link>}
          </div>
        </div>
      )}

      {/* Push to smartly — only for plans that support it */}
      {plan.features.destinations.includes('smartly') && (
        <div className="mt-10">
          <PushToSmartlyForm clientSlug={active.slug} />
        </div>
      )}
    </div>
  );
}

function tierBadgeClass(tier: string): string {
  const base = 'rounded-full px-2 py-0.5 text-xs font-medium';
  switch (tier) {
    case 'premium':     return `${base} bg-emerald-100 text-emerald-900`;
    case 'standard':    return `${base} bg-sky-100 text-sky-900`;
    case 'prospecting': return `${base} bg-indigo-50 text-indigo-800`;
    case 'review':      return `${base} bg-amber-100 text-amber-900`;
    case 'hold':        return `${base} bg-neutral-200 text-neutral-700`;
    case 'discard':     return `${base} bg-red-50 text-red-800`;
    default:            return `${base} bg-neutral-100 text-neutral-700`;
  }
}
