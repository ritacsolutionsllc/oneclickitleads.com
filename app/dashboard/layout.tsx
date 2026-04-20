import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import DashboardNav from '@/components/DashboardNav';
import ClientSwitcher from '@/components/ClientSwitcher';
import SignOutButton from '@/components/SignOutButton';

/**
 * Dashboard shell:
 *   Top bar: logo · client switcher · user
 *   Sidebar: Overview, Leads, Suppressions, Exports, Billing, Settings
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // The entire auth bootstrap is wrapped so that ANY failure — missing env
  // vars, corrupt cookies, Supabase degraded — bounces the visitor to /login
  // instead of rendering a 500 page. This is the entry point reached by the
  // "Client login" link on the marketing site, so it must never crash.
  type ClientRow = { id: string; name: string; slug: string; plan: string };
  let user: { id: string; email?: string | null } | null = null;
  let clients: ClientRow[] = [];
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.error('[dashboard/layout] getUser error:', error);
    } else {
      user = data.user;
    }
    if (user) {
      const { data: rows, error: qErr } = await supabase
        .from('clients')
        .select('id, name, slug, plan')
        .eq('owner_user', user.id)
        .order('created_at');
      if (qErr) console.error('[dashboard/layout] clients query error:', qErr);
      clients = (rows ?? []).map((r) => ({
        id: String(r.id),
        name: String(r.name),
        slug: String(r.slug),
        plan: String(r.plan ?? ''),
      }));
    }
  } catch (err) {
    console.error('[dashboard/layout] bootstrap threw:', err);
  }

  if (!user) redirect('/login');

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Top bar */}
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="font-semibold">OneClickitLeads</Link>
            <ClientSwitcher clients={clients ?? []} />
          </div>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/pricing" className="text-neutral-600 hover:text-neutral-900">Pricing</Link>
            <span className="text-neutral-600 hidden md:inline">{user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-8 grid md:grid-cols-[220px_1fr] gap-8">
        <DashboardNav />
        <div>{children}</div>
      </div>
    </div>
  );
}
