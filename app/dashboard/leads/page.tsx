import { createClient } from '@/utils/supabase/server';
import Link from 'next/link';
import PushToSmartlyForm from '@/components/PushToSmartlyForm';

type SP = {
  searchParams: {
    client?: string;
    segment?: string;
    scrubbed?: string;
    page?: string;
    q?: string;
    minScore?: string;
  };
};

const PAGE_SIZE = 50;

export default async function LeadsPage({ searchParams }: SP) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients').select('id, slug, name, plan').eq('owner_user', user.id);
  const active = (clients ?? []).find((c) => c.slug === searchParams.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const page = Math.max(1, Number(searchParams.page ?? 1));
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = supabase
    .from('leads')
    .select(
      'id, first_name, last_name, email, phone_e164, company, title, city, region, icp_segment, scrub_score, is_scrubbed, reject_reason, created_at',
      { count: 'exact' }
    )
    .eq('client_id', active.id);

  if (searchParams.segment) q = q.eq('icp_segment', searchParams.segment);
  if (searchParams.scrubbed === '1') q = q.eq('is_scrubbed', true);
  if (searchParams.scrubbed === '0') q = q.eq('is_scrubbed', false);
  if (searchParams.minScore) q = q.gte('scrub_score', Number(searchParams.minScore));
  if (searchParams.q) {
    const term = searchParams.q;
    q = q.or(`email.ilike.%${term}%,company.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`);
  }

  const { data: leads, count } = await q
    .order('lead_quality_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(from, to);

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Preserve current filters across links
  const baseParams = new URLSearchParams();
  baseParams.set('client', active.slug);
  if (searchParams.segment) baseParams.set('segment', searchParams.segment);
  if (searchParams.scrubbed) baseParams.set('scrubbed', searchParams.scrubbed);
  if (searchParams.minScore) baseParams.set('minScore', searchParams.minScore);
  if (searchParams.q) baseParams.set('q', searchParams.q);
  const pageLink = (p: number) => {
    const u = new URLSearchParams(baseParams);
    u.set('page', String(p));
    return `/dashboard/leads?${u.toString()}`;
  };

  const exportLink = `/api/export?client=${active.slug}&format=csv${
    searchParams.segment ? `&segment=${searchParams.segment}` : ''
  }${searchParams.scrubbed ? `&scrubbed=${searchParams.scrubbed}` : ''}${
    searchParams.q ? `&q=${encodeURIComponent(searchParams.q)}` : ''
  }${searchParams.minScore ? `&min_score=${searchParams.minScore}` : ''}`;

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-neutral-600">{total.toLocaleString()} total · {active.name}</p>
        </div>
        <div className="flex gap-2">
          {searchParams.scrubbed === '0' ? (
            <span className="rounded-full bg-neutral-200 text-neutral-700 px-4 py-2 text-sm">
              Export unavailable for rejected-only
            </span>
          ) : (
            <Link href={exportLink} className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700">
              Export filtered CSV
            </Link>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <form method="get" className="mt-6 rounded-xl border border-neutral-200 bg-white p-4 grid md:grid-cols-5 gap-3">
        <input type="hidden" name="client" value={active.slug} />
        <input
          name="q"
          defaultValue={searchParams.q ?? ''}
          placeholder="Search email, company, name"
          className="md:col-span-2 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        />
        <select name="segment" defaultValue={searchParams.segment ?? ''} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">
          <option value="">All segments</option>
          <optgroup label="Beauty &amp; Wellness">
            <option value="salon">salon</option>
            <option value="b2c_beauty">b2c_beauty</option>
            <option value="medspa">medspa</option>
            <option value="wellness">wellness</option>
            <option value="influencer">influencer</option>
          </optgroup>
          <optgroup label="Fitness &amp; Health">
            <option value="fitness">fitness</option>
            <option value="healthcare">healthcare</option>
            <option value="pharmacy">pharmacy</option>
          </optgroup>
          <optgroup label="Retail">
            <option value="retailer">retailer</option>
            <option value="retail">retail</option>
            <option value="ecommerce">ecommerce</option>
          </optgroup>
          <optgroup label="Food &amp; Hospitality">
            <option value="restaurant">restaurant</option>
            <option value="food_truck">food_truck</option>
            <option value="hospitality">hospitality</option>
          </optgroup>
          <optgroup label="Professional Services">
            <option value="real_estate">real_estate</option>
            <option value="professional_services">professional_services</option>
            <option value="marketing_agency">marketing_agency</option>
          </optgroup>
          <optgroup label="Home &amp; Auto">
            <option value="home_services">home_services</option>
            <option value="automotive">automotive</option>
          </optgroup>
          <optgroup label="Other">
            <option value="education">education</option>
            <option value="tech">tech</option>
            <option value="nonprofit">nonprofit</option>
          </optgroup>
        </select>
        <select name="scrubbed" defaultValue={searchParams.scrubbed ?? ''} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">
          <option value="">Any status</option>
          <option value="1">Scrubbed only</option>
          <option value="0">Rejected only</option>
        </select>
        <div className="flex gap-2">
          <input
            name="minScore"
            type="number"
            min={0}
            max={100}
            defaultValue={searchParams.minScore ?? ''}
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
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-left px-4 py-3">Email</th>
                <th className="text-left px-4 py-3">Company</th>
                <th className="text-left px-4 py-3">City</th>
                <th className="text-left px-4 py-3">Segment</th>
                <th className="text-left px-4 py-3">Score</th>
                <th className="text-left px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(leads ?? []).map((l: any) => (
                <tr key={l.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    {l.first_name || l.last_name ? `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{l.email ?? '—'}</td>
                  <td className="px-4 py-3">{l.company ?? '—'}</td>
                  <td className="px-4 py-3">{l.city ? `${l.city}${l.region ? `, ${l.region}` : ''}` : '—'}</td>
                  <td className="px-4 py-3">
                    {l.icp_segment ? (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">{l.icp_segment}</span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {l.scrub_score ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {l.is_scrubbed ? (
                      <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs">clean</span>
                    ) : l.reject_reason ? (
                      <span title={l.reject_reason} className="rounded-full bg-red-50 text-red-800 px-2 py-0.5 text-xs">
                        {l.reject_reason}
                      </span>
                    ) : (
                      <span className="rounded-full bg-neutral-100 text-neutral-700 px-2 py-0.5 text-xs">pending</span>
                    )}
                  </td>
                </tr>
              ))}
              {(!leads || leads.length === 0) && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-neutral-500">
                    No leads match these filters.
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

      {/* Push to smartly */}
      <div className="mt-10">
        <PushToSmartlyForm clientSlug={active.slug} />
      </div>
    </div>
  );
}
