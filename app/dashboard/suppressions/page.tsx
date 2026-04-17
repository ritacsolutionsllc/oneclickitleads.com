import { createClient } from '@/utils/supabase/server';
import SuppressionManager from '@/components/SuppressionManager';

export default async function SuppressionsPage({ searchParams }: { searchParams: { client?: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients').select('id, slug, name').eq('owner_user', user.id);
  const active = (clients ?? []).find((c) => c.slug === searchParams.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const [{ data: suppressions, count }, { data: breakdown }] = await Promise.all([
    supabase
      .from('suppressions')
      .select('id, email, phone, reason, added_at', { count: 'exact' })
      .eq('client_id', active.id)
      .order('added_at', { ascending: false })
      .limit(500),
    supabase
      .from('suppressions')
      .select('reason')
      .eq('client_id', active.id),
  ]);

  const counts: Record<string, number> = {};
  for (const r of breakdown ?? []) {
    const k = (r as any).reason ?? 'other';
    counts[k] = (counts[k] ?? 0) + 1;
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">Suppressions</h1>
      <p className="text-sm text-neutral-600">
        Rows here are blocked from every export and push. Total: {count ?? 0}
      </p>

      <div className="mt-6 grid md:grid-cols-4 gap-3">
        {['existing_customer', 'unsubscribed', 'bounced', 'spam', 'competitor'].map((r) => (
          <div key={r} className="rounded-xl border border-neutral-200 bg-white p-4">
            <div className="text-xs text-neutral-500 uppercase">{r}</div>
            <div className="text-2xl font-semibold">{(counts[r] ?? 0).toLocaleString()}</div>
          </div>
        ))}
      </div>

      <SuppressionManager clientSlug={active.slug} initial={suppressions ?? []} />
    </div>
  );
}
