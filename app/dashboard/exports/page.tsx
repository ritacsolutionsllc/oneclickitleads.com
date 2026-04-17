import { createClient } from '@/utils/supabase/server';
import Link from 'next/link';

export default async function ExportsPage({ searchParams }: { searchParams: { client?: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients').select('id, slug, name').eq('owner_user', user.id);
  const active = (clients ?? []).find((c) => c.slug === searchParams.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const { data: exports } = await supabase
    .from('exports')
    .select('id, destination, row_count, filters, created_at')
    .eq('client_id', active.id)
    .order('created_at', { ascending: false })
    .limit(200);

  return (
    <div>
      <h1 className="text-2xl font-semibold">Exports</h1>
      <p className="text-sm text-neutral-600">
        Full audit trail of every CSV generated and every audience pushed to smartly.io.
      </p>

      <div className="mt-4 flex gap-2">
        <Link href={`/api/export?client=${active.slug}&format=csv`} className="rounded-full bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700">
          Download full CSV
        </Link>
        <Link href={`/dashboard/leads?client=${active.slug}`} className="rounded-full border border-neutral-300 px-4 py-2 text-sm hover:bg-white">
          Filter → export
        </Link>
      </div>

      <div className="mt-6 rounded-xl border border-neutral-200 bg-white overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500">
            <tr>
              <th className="text-left px-4 py-3">When</th>
              <th className="text-left px-4 py-3">Destination</th>
              <th className="text-left px-4 py-3">Rows</th>
              <th className="text-left px-4 py-3">Filters</th>
              <th className="text-left px-4 py-3">ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(exports ?? []).map((e: any) => (
              <tr key={e.id}>
                <td className="px-4 py-3 text-neutral-600">{new Date(e.created_at).toLocaleString()}</td>
                <td className="px-4 py-3 font-medium capitalize">{e.destination}</td>
                <td className="px-4 py-3">{e.row_count.toLocaleString()}</td>
                <td className="px-4 py-3 text-xs text-neutral-600 font-mono max-w-md truncate">
                  {JSON.stringify(e.filters ?? {})}
                </td>
                <td className="px-4 py-3 text-xs text-neutral-400 font-mono">{e.id.slice(0, 8)}</td>
              </tr>
            ))}
            {(!exports || exports.length === 0) && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-neutral-500">No exports yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
