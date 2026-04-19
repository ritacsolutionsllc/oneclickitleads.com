import { createClient } from '@/utils/supabase/server';
import Link from 'next/link';
import ReviewQueueTable from '@/components/ReviewQueueTable';

type QueueState = 'review' | 'quarantine' | 'rejected';

type SP = {
  searchParams: Promise<{ client?: string; state?: string }>;
};

const STATES: { key: QueueState; label: string; hint: string }[] = [
  { key: 'review',     label: 'Needs review',   hint: 'Borderline scores — approve the good ones, reject the rest.' },
  { key: 'quarantine', label: 'Quarantine',     hint: 'Too weak to export. Safe to reject, or requeue after re-verify.' },
  { key: 'rejected',   label: 'Rejected',       hint: 'Hard rejects (disposable, duplicate, bad syntax). Requeue only if you fixed the cause.' },
];

export default async function QualityPage({ searchParams }: SP) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const stateParam = (sp.state ?? 'review') as QueueState;
  const state: QueueState = (['review', 'quarantine', 'rejected'] as const).includes(stateParam)
    ? stateParam
    : 'review';

  const { data: clients } = await supabase
    .from('clients').select('id, slug, name').eq('owner_user', user.id).order('created_at');
  const active = (clients ?? []).find((c) => c.slug === sp.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const [qualityRes, usageRes, queueRes] = await Promise.all([
    supabase.from('v_client_quality').select('*').eq('client_id', active.id).maybeSingle(),
    supabase.from('v_client_usage')
      .select('clean_this_month, review_this_month, quarantine_this_month')
      .eq('client_id', active.id).maybeSingle(),
    supabase.from('leads')
      .select('id, email, phone_e164, first_name, last_name, company, city, region, icp_segment, quality_score, verification_status, source_tier, export_eligibility, reason_codes, last_verified_at, created_at')
      .eq('client_id', active.id)
      .eq('export_eligibility', state)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const quality = qualityRes.data;
  const usage = usageRes.data;
  const queue = queueRes.data ?? [];

  const total = Number(quality?.total_leads ?? 0);
  const eligible = Number(quality?.eligible ?? 0);
  const needsReview = Number(quality?.needs_review ?? 0);
  const quarantined = Number(quality?.quarantined ?? 0);
  const rejected = Number(quality?.rejected ?? 0);
  const avgQ = quality?.avg_quality_eligible != null ? Math.round(Number(quality.avg_quality_eligible)) : null;
  const eligiblePct = total ? Math.round((eligible / total) * 100) : 0;

  const tierRows = [
    { tier: 'A', label: '1st-party',  count: Number(quality?.tier_a ?? 0) },
    { tier: 'B', label: 'Paid API',   count: Number(quality?.tier_b ?? 0) },
    { tier: 'C', label: 'Directory',  count: Number(quality?.tier_c ?? 0) },
    { tier: 'D', label: 'Scraped',    count: Number(quality?.tier_d ?? 0) },
  ];
  const tierMax = Math.max(1, ...tierRows.map((r) => r.count));

  const verificationRows = [
    { key: 'first_party',   label: 'First-party',   count: Number(quality?.first_party ?? 0) },
    { key: 'smtp_verified', label: 'SMTP verified', count: Number(quality?.smtp_verified ?? 0) },
  ];

  const stateLink = (s: QueueState) => {
    const u = new URLSearchParams();
    u.set('client', active.slug);
    u.set('state', s);
    return `/dashboard/quality?${u.toString()}`;
  };

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Quality</h1>
          <p className="text-sm text-neutral-600">
            {active.name} · every lead is scored, tiered, and explainable before export.
          </p>
        </div>
        <Link
          href={`/api/export?client=${active.slug}&format=csv`}
          className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700"
        >
          Export eligible CSV
        </Link>
      </div>

      {/* Eligibility stats */}
      <div className="mt-6 grid md:grid-cols-4 gap-4">
        <Stat label="Eligible" value={eligible} accent sub={`${eligiblePct}% of total`} />
        <Stat label="Needs review" value={needsReview} sub="Borderline — approve or reject" />
        <Stat label="Quarantine" value={quarantined} sub="Too weak to export" />
        <Stat label="Avg quality (eligible)" value={avgQ ?? '—'} sub="0–100 score" />
      </div>

      {/* Tier breakdown */}
      <div className="mt-8 grid md:grid-cols-2 gap-6">
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-baseline justify-between">
            <div className="font-medium">Source tier breakdown</div>
            <div className="text-xs text-neutral-500">{total.toLocaleString()} total</div>
          </div>
          <div className="mt-4 space-y-3">
            {tierRows.map((r) => {
              const pct = total ? Math.round((r.count / total) * 100) : 0;
              const barPct = Math.round((r.count / tierMax) * 100);
              return (
                <div key={r.tier}>
                  <div className="flex items-baseline justify-between text-xs text-neutral-600">
                    <span>
                      <span className="font-mono font-semibold text-neutral-900">{r.tier}</span>
                      <span className="ml-2">{r.label}</span>
                    </span>
                    <span>
                      <span className="font-medium text-neutral-900">{r.count.toLocaleString()}</span>
                      <span className="ml-1 text-neutral-500">({pct}%)</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-neutral-100 overflow-hidden">
                    <div
                      className={`h-full ${
                        r.tier === 'A' ? 'bg-emerald-500'
                        : r.tier === 'B' ? 'bg-sky-500'
                        : r.tier === 'C' ? 'bg-amber-500'
                        : 'bg-neutral-400'
                      }`}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-baseline justify-between">
            <div className="font-medium">This month</div>
            <div className="text-xs text-neutral-500">Resets on the 1st</div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wider text-neutral-500">Clean</div>
              <div className="text-2xl font-semibold text-emerald-700">
                {Number(usage?.clean_this_month ?? 0).toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-neutral-500">Review</div>
              <div className="text-2xl font-semibold text-amber-700">
                {Number(usage?.review_this_month ?? 0).toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-neutral-500">Quarantine</div>
              <div className="text-2xl font-semibold text-orange-700">
                {Number(usage?.quarantine_this_month ?? 0).toLocaleString()}
              </div>
            </div>
          </div>

          <div className="mt-6 border-t border-neutral-100 pt-4">
            <div className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Verification</div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              {verificationRows.map((v) => (
                <div key={v.key}>
                  <div className="text-xs text-neutral-600">{v.label}</div>
                  <div className="text-lg font-semibold">{v.count.toLocaleString()}</div>
                </div>
              ))}
              <div>
                <div className="text-xs text-neutral-600">Rejected (total)</div>
                <div className="text-lg font-semibold text-red-700">{rejected.toLocaleString()}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Review queue */}
      <div className="mt-10">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold">Review queue</h2>
            <p className="text-sm text-neutral-600">
              {STATES.find((s) => s.key === state)?.hint}
            </p>
          </div>
          <div className="flex gap-2 text-sm">
            {STATES.map((s) => (
              <Link
                key={s.key}
                href={stateLink(s.key)}
                className={`rounded-full px-3 py-1.5 ${
                  state === s.key
                    ? 'bg-neutral-900 text-white'
                    : 'border border-neutral-300 text-neutral-700 hover:bg-neutral-100'
                }`}
              >
                {s.label}
                <span className="ml-2 text-xs opacity-70">
                  {s.key === 'review' ? needsReview : s.key === 'quarantine' ? quarantined : rejected}
                </span>
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <ReviewQueueTable initialLeads={queue} state={state} />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-5 ${accent ? 'border-emerald-500 bg-emerald-50' : 'border-neutral-200 bg-white'}`}>
      <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {sub && <div className="mt-1 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}
