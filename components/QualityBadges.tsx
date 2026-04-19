import { ELIGIBILITY_LABEL, reasonMeta, type ReasonSeverity } from '@/lib/reasonCodes';

const SEVERITY_CLASSES: Record<ReasonSeverity, string> = {
  good: 'bg-emerald-100 text-emerald-800',
  info: 'bg-sky-100 text-sky-800',
  warn: 'bg-amber-100 text-amber-800',
  bad:  'bg-red-100 text-red-800',
};

const ELIGIBILITY_CLASSES: Record<string, string> = {
  eligible: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  review: 'bg-amber-100 text-amber-800 border-amber-200',
  quarantine: 'bg-orange-100 text-orange-800 border-orange-200',
  rejected: 'bg-red-100 text-red-800 border-red-200',
};

export function EligibilityPill({ value }: { value: string | null | undefined }) {
  const v = value ?? 'review';
  const cls = ELIGIBILITY_CLASSES[v] ?? 'bg-neutral-100 text-neutral-700 border-neutral-200';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {ELIGIBILITY_LABEL[v] ?? v}
    </span>
  );
}

export function SourceTierBadge({ tier }: { tier: string | null | undefined }) {
  if (!tier) return <span className="text-neutral-400 text-xs">—</span>;
  const label = tier === 'A' ? '1st-party'
    : tier === 'B' ? 'Paid API'
    : tier === 'C' ? 'Directory'
    : tier === 'D' ? 'Scraped'
    : tier;
  return (
    <span
      title={`Source tier ${tier}`}
      className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-xs"
    >
      <span className="font-mono font-semibold">{tier}</span>
      <span className="text-neutral-600">{label}</span>
    </span>
  );
}

export function QualityScore({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-neutral-400">—</span>;
  const n = Number(value);
  const color =
    n >= 70 ? 'text-emerald-700' : n >= 40 ? 'text-amber-700' : 'text-red-700';
  return <span className={`font-semibold tabular-nums ${color}`}>{n}</span>;
}

export function ReasonCodeChips({
  codes,
  limit,
}: {
  codes: string[] | null | undefined;
  limit?: number;
}) {
  if (!codes || codes.length === 0) return <span className="text-neutral-400 text-xs">—</span>;
  const show = limit ? codes.slice(0, limit) : codes;
  const rest = limit && codes.length > limit ? codes.length - limit : 0;
  return (
    <div className="flex flex-wrap gap-1">
      {show.map((c) => {
        const meta = reasonMeta(c);
        return (
          <span
            key={c}
            title={c}
            className={`rounded px-1.5 py-0.5 text-[11px] ${SEVERITY_CLASSES[meta.severity]}`}
          >
            {meta.label}
          </span>
        );
      })}
      {rest > 0 && (
        <span className="rounded bg-neutral-100 text-neutral-600 px-1.5 py-0.5 text-[11px]">
          +{rest}
        </span>
      )}
    </div>
  );
}
