import { createClient } from '@/utils/supabase/server';
import Link from 'next/link';

type SP = { searchParams: Promise<{ client?: string }> };

interface QualityRow {
  client_id: string;
  scrubbed_total: number | null;
  tier_premium: number | null;
  tier_standard: number | null;
  tier_prospecting: number | null;
  tier_review: number | null;
  tier_hold: number | null;
  tier_discard: number | null;
  avg_composite: number | null;
  stale_count: number | null;
}

const TIERS: Array<{
  key: 'premium' | 'standard' | 'prospecting' | 'review' | 'hold' | 'discard';
  label: string;
  band: string;
  barClass: string;
  description: string;
}> = [
  { key: 'premium',     label: 'Premium',     band: '≥ 80', barClass: 'bg-emerald-500', description: 'Auto-ship to top audiences.' },
  { key: 'standard',    label: 'Standard',    band: '65–79', barClass: 'bg-sky-500',     description: 'Auto-ship to main audiences.' },
  { key: 'prospecting', label: 'Prospecting', band: '50–64', barClass: 'bg-indigo-400',  description: 'Auto-ship to prospecting audiences.' },
  { key: 'review',      label: 'Review',      band: '35–49', barClass: 'bg-amber-500',   description: 'Manual approval in review queue.' },
  { key: 'hold',        label: 'Hold',        band: '20–34', barClass: 'bg-neutral-400', description: 'Held back, not exported.' },
  { key: 'discard',     label: 'Discard',     band: '< 20',  barClass: 'bg-red-400',     description: 'Suppressed, duplicate, or below floor.' },
];

export default async function QualityPage({ searchParams }: SP) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients').select('id, slug, name').eq('owner_user', user.id);
  const active = (clients ?? []).find((c) => c.slug === sp.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const { data: quality } = await supabase
    .from('v_client_quality')
    .select('*')
    .eq('client_id', active.id)
    .maybeSingle<QualityRow>();

  const row = quality ?? ({} as Partial<QualityRow>);
  const total = Number(row.scrubbed_total ?? 0);
  const avg = row.avg_composite != null ? Math.round(Number(row.avg_composite)) : null;
  const stale = Number(row.stale_count ?? 0);
  const counts: Record<typeof TIERS[number]['key'], number> = {
    premium:     Number(row.tier_premium ?? 0),
    standard:    Number(row.tier_standard ?? 0),
    prospecting: Number(row.tier_prospecting ?? 0),
    review:      Number(row.tier_review ?? 0),
    hold:        Number(row.tier_hold ?? 0),
    discard:     Number(row.tier_discard ?? 0),
  };
  const tieredTotal = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Quality</h1>
          <p className="text-sm text-neutral-600">
            Composite score & tier distribution for {active.name}. Weights: identity 30 · ICP fit 25 · completeness 20 · freshness 15 · intent 7 · source 3.
          </p>
        </div>
        <Link href={`/dashboard/leads?client=${active.slug}`} className="rounded-full border border-neutral-300 px-4 py-2 text-sm hover:bg-white">
          View leads →
        </Link>
      </div>

      <div className="mt-6 grid md:grid-cols-3 gap-4">
        <Stat label="Scrubbed leads" value={total} />
        <Stat label="Avg composite" value={avg == null ? '—' : `${avg} / 100`} accent />
        <Stat
          label="Stale (90d+)"
          value={stale}
          hint={stale > 0 ? 'Re-verify to keep freshness score up' : 'Everything fresh'}
        />
      </div>

      {/* Tier distribution */}
      <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex items-baseline justify-between">
          <div className="font-medium">Tier distribution</div>
          <div className="text-xs text-neutral-500">{tieredTotal.toLocaleString()} assigned tiers</div>
        </div>
        <div className="mt-5 space-y-4">
          {TIERS.map((t) => {
            const n = counts[t.key];
            const pct = tieredTotal ? Math.round((n / tieredTotal) * 100) : 0;
            const leadsHref = `/dashboard/leads?client=${active.slug}&tier=${t.key}`;
            const exportHref = `/api/export?client=${active.slug}&format=csv&tier=${t.key}`;
            return (
              <div key={t.key}>
                <div className="flex items-baseline justify-between text-sm">
                  <div className="flex items-baseline gap-3">
                    <span className="font-medium">{t.label}</span>
                    <span className="text-xs text-neutral-500">{t.band}</span>
                  </div>
                  <div className="text-sm text-neutral-700">
                    <strong>{n.toLocaleString()}</strong>
                    <span className="text-neutral-500"> · {pct}%</span>
                  </div>
                </div>
                <div className="mt-1 h-2 rounded-full bg-neutral-100 overflow-hidden">
                  <div className={`h-full ${t.barClass}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 flex items-baseline justify-between text-xs text-neutral-500">
                  <span>{t.description}</span>
                  {n > 0 && (
                    <div className="flex gap-3">
                      <Link href={leadsHref} className="text-emerald-700 hover:underline">
                        browse →
                      </Link>
                      {(t.key === 'premium' || t.key === 'standard' || t.key === 'prospecting') && (
                        <Link href={exportHref} className="text-sky-700 hover:underline">
                          export CSV →
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-5 text-sm text-neutral-700">
        <div className="font-medium text-neutral-900">How the composite is built</div>
        <p className="mt-2 text-neutral-600">
          Every scrubbed lead gets six sub-scores in [0,1], combined with fixed weights into a 0–100 composite. The composite is a stored generated column in Postgres — it cannot drift from the sub-scores. Tier bands map composite → {TIERS.map((t) => t.label.toLowerCase()).join(' / ')}. Your <Link href="/dashboard/settings" className="text-emerald-700 hover:underline">export policy</Link> controls which tiers ship automatically.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, accent, hint }: { label: string; value: number | string; accent?: boolean; hint?: string }) {
  return (
    <div className={`rounded-xl border p-5 ${accent ? 'border-emerald-500 bg-emerald-50' : 'border-neutral-200 bg-white'}`}>
      <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div className="mt-1 text-xs text-neutral-500">{hint}</div>}
    </div>
  );
}
