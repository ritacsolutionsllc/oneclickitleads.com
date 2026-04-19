import { createClient } from '@/utils/supabase/server';
import Link from 'next/link';
import PushToSmartlyForm from '@/components/PushToSmartlyForm';
import {
  EligibilityPill,
  SourceTierBadge,
  QualityScore,
  ReasonCodeChips,
} from '@/components/QualityBadges';

type SP = {
  searchParams: Promise<{
    client?: string;
    segment?: string;
    eligibility?: string;
    tier?: string;
    page?: string;
    q?: string;
    minScore?: string;
  }>;
};

const PAGE_SIZE = 50;
const ELIGIBILITY_VALUES = ['eligible', 'review', 'quarantine', 'rejected'] as const;
const TIER_VALUES = ['A', 'B', 'C', 'D'] as const;

export default async function LeadsPage({ searchParams }: SP) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients').select('id, slug, name, plan').eq('owner_user', user.id);
  const active = (clients ?? []).find((c) => c.slug === sp.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const page = Math.max(1, Number(sp.page ?? 1));
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = supabase
    .from('leads')
    .select(
      'id, first_name, last_name, email, phone_e164, company, title, city, region, icp_segment, quality_score, verification_status, source_tier, export_eligibility, reason_codes, created_at',
      { count: 'exact' }
    )
    .eq('client_id', active.id);

  if (sp.segment) q = q.eq('icp_segment', sp.segment);
  if (sp.eligibility && (ELIGIBILITY_VALUES as readonly string[]).includes(sp.eligibility)) {
    q = q.eq('export_eligibility', sp.eligibility);
  }
  if (sp.tier && (TIER_VALUES as readonly string[]).includes(sp.tier)) {
    q = q.eq('source_tier', sp.tier);
  }
  if (sp.minScore) q = q.gte('quality_score', Number(sp.minScore));
  if (sp.q) {
    const term = sp.q;
    q = q.or(`email.ilike.%${term}%,company.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`);
  }

  const { data: leads, count } = await q
    .order('quality_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(from, to);

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const baseParams = new URLSearchParams();
  baseParams.set('client', active.slug);
  if (sp.segment) baseParams.set('segment', sp.segment);
  if (sp.eligibility) baseParams.set('eligibility', sp.eligibility);
  if (sp.tier) baseParams.set('tier', sp.tier);
  if (sp.minScore) baseParams.set('minScore', sp.minScore);
  if (sp.q) baseParams.set('q', sp.q);
  const pageLink = (p: number) => {
    const u = new URLSearchParams(baseParams);
    u.set('page', String(p));
    return `/dashboard/leads?${u.toString()}`;
  };

  const exportLink = `/api/export?client=${active.slug}&format=csv${
    sp.segment ? `&segment=${sp.segment}` : ''
  }${sp.minScore ? `&min_score=${sp.minScore}` : ''}`;

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-neutral-600">
            {total.toLocaleString()} total · {active.name} · sorted by quality score
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/dashboard/quality?client=${active.slug}`}
            className="rounded-full border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100"
          >
            Review queue →
          </Link>
          <Link href={exportLink} className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700">
            Export eligible CSV
          </Link>
        </div>
      </div>

      {/* Filter bar */}
      <form method="get" className="mt-6 rounded-xl border border-neutral-200 bg-white p-4 grid md:grid-cols-6 gap-3">
        <input type="hidden" name="client" value={active.slug} />
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
        <select name="eligibility" defaultValue={sp.eligibility ?? ''} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">
          <option value="">Any eligibility</option>
          <option value="eligible">Eligible</option>
          <option value="review">In review</option>
          <option value="quarantine">Quarantine</option>
          <option value="rejected">Rejected</option>
        </select>
        <select name="tier" defaultValue={sp.tier ?? ''} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">
          <option value="">Any tier</option>
          <option value="A">A · 1st-party</option>
          <option value="B">B · Paid API</option>
          <option value="C">C · Directory</option>
          <option value="D">D · Scraped</option>
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
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-left px-4 py-3">Email</th>
                <th className="text-left px-4 py-3">Company</th>
                <th className="text-left px-4 py-3">Segment</th>
                <th className="text-left px-4 py-3">Score</th>
                <th className="text-left px-4 py-3">Tier</th>
                <th className="text-left px-4 py-3">Eligibility</th>
                <th className="text-left px-4 py-3">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(leads ?? []).map((l: {
                id: string;
                first_name: string | null;
                last_name: string | null;
                email: string | null;
                company: string | null;
                icp_segment: string | null;
                quality_score: number | null;
                source_tier: string | null;
                export_eligibility: string | null;
                reason_codes: string[] | null;
              }) => (
                <tr key={l.id} className="hover:bg-neutral-50 align-top">
                  <td className="px-4 py-3">
                    {l.first_name || l.last_name ? `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{l.email ?? '—'}</td>
                  <td className="px-4 py-3">{l.company ?? '—'}</td>
                  <td className="px-4 py-3">
                    {l.icp_segment ? (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">{l.icp_segment}</span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <QualityScore value={l.quality_score} />
                  </td>
                  <td className="px-4 py-3">
                    <SourceTierBadge tier={l.source_tier} />
                  </td>
                  <td className="px-4 py-3">
                    <EligibilityPill value={l.export_eligibility} />
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <ReasonCodeChips codes={l.reason_codes} limit={3} />
                  </td>
                </tr>
              ))}
              {(!leads || leads.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-neutral-500">
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
