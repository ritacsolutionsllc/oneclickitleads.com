import { createClient } from '@/utils/supabase/server';
import Link from 'next/link';
import { planByTier } from '@/lib/plans';

type SP = { searchParams: { client?: string; upgraded?: string; tier?: string } };

export default async function Overview({ searchParams }: SP) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null; // layout redirects

  const { data: clients } = await supabase
    .from('clients')
    .select('id, name, slug, plan')
    .eq('owner_user', user.id)
    .order('created_at');

  const active = (clients ?? []).find((c) => c.slug === searchParams.client) ?? clients?.[0];
  if (!active) {
    return (
      <EmptyState title="Create your first client" body="Use the '+ Create' button in the top nav to spin up your first tenant. Then you can start scraping, importing, and pushing leads." />
    );
  }

  const plan = planByTier(active.plan);

  const [{ count: leadTotal }, { count: cleanTotal }, { data: usage }, { count: suppressCount }, { data: recentExports }] = await Promise.all([
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('client_id', active.id),
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('client_id', active.id).eq('is_scrubbed', true),
    supabase.from('v_client_usage').select('leads_this_month, clean_this_month, monthly_cap, segments_used_this_month').eq('client_id', active.id).maybeSingle(),
    supabase.from('suppressions').select('*', { count: 'exact', head: true }).eq('client_id', active.id),
    supabase.from('exports').select('id, destination, row_count, created_at, filters').eq('client_id', active.id).order('created_at', { ascending: false }).limit(5),
  ]);

  const pct = leadTotal ? Math.round(((cleanTotal ?? 0) / leadTotal) * 100) : 0;
  const used = Number(usage?.clean_this_month ?? 0);
  const cap  = Number(usage?.monthly_cap ?? plan.features.monthlyCleanLeads);
  const capPct = Math.min(100, Math.round((used / cap) * 100));

  return (
    <div>
      {searchParams.upgraded && (
        <div className="mb-6 rounded-xl border border-emerald-300 bg-emerald-50 px-5 py-4 text-emerald-900">
          Subscription active — you're on the <strong>{searchParams.tier ?? 'new'}</strong> plan. 14-day trial running.
        </div>
      )}

      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{active.name}</h1>
          <p className="text-sm text-neutral-600">/{active.slug} · {plan.name} plan · {plan.tagline}</p>
        </div>
        <div className="flex gap-2">
          <Link href={`/dashboard/scrape?client=${active.slug}`} className="rounded-full bg-neutral-900 text-white px-4 py-2 text-sm hover:bg-black">
            Scrape
          </Link>
          <Link href={`/dashboard/leads?client=${active.slug}`} className="rounded-full border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100">
            View leads →
          </Link>
          <Link href={`/api/export?client=${active.slug}&format=csv`} className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700">
            Export CSV
          </Link>
        </div>
      </div>

      <div className="mt-6 grid md:grid-cols-4 gap-4">
        <Stat label="Total leads" value={leadTotal ?? 0} />
        <Stat label="Scrubbed" value={cleanTotal ?? 0} accent />
        <Stat label="Clean rate" value={`${pct}%`} />
        <Stat label="Suppressions" value={suppressCount ?? 0} />
      </div>

      {/* Usage meter */}
      <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex justify-between items-baseline">
          <div>
            <div className="font-medium">Monthly usage</div>
            <div className="text-xs text-neutral-500">Resets on the 1st of the month</div>
          </div>
          <div className="text-sm">
            <strong>{used.toLocaleString()}</strong> / {cap.toLocaleString()} clean leads
          </div>
        </div>
        <div className="mt-3 h-3 rounded-full bg-neutral-100 overflow-hidden">
          <div
            className={`h-full ${capPct > 90 ? 'bg-red-500' : capPct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${capPct}%` }}
          />
        </div>
        {capPct > 70 && (
          <div className="mt-3 text-sm">
            <Link href="/dashboard/billing" className="text-emerald-700 font-medium hover:underline">
              {capPct >= 100 ? 'Upgrade to keep exporting →' : 'Running hot — consider upgrading →'}
            </Link>
          </div>
        )}
      </div>

      {/* Recent exports */}
      <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex justify-between items-center mb-4">
          <div className="font-medium">Recent exports</div>
          <Link href={`/dashboard/exports?client=${active.slug}`} className="text-sm text-emerald-700 hover:underline">
            View all →
          </Link>
        </div>
        {recentExports && recentExports.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-500 text-xs">
              <tr>
                <th className="pb-2">When</th>
                <th className="pb-2">Destination</th>
                <th className="pb-2">Rows</th>
                <th className="pb-2">Segment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {recentExports.map((e: any) => (
                <tr key={e.id}>
                  <td className="py-2 text-neutral-600">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="py-2 font-medium capitalize">{e.destination}</td>
                  <td className="py-2">{e.row_count.toLocaleString()}</td>
                  <td className="py-2 text-neutral-600">{e.filters?.segment ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-neutral-500 py-6 text-center">
            No exports yet. Hit <strong>Export CSV</strong> above or push directly to smartly.io from the Leads page.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-5 ${accent ? 'border-emerald-500 bg-emerald-50' : 'border-neutral-200 bg-white'}`}>
      <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
      <div className="text-lg font-medium">{title}</div>
      <div className="mt-2 text-sm text-neutral-600">{body}</div>
    </div>
  );
}
