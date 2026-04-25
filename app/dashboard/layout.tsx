import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';
import DashboardNav from '@/components/DashboardNav';
import ClientSwitcher from '@/components/ClientSwitcher';
import SignOutButton from '@/components/SignOutButton';

/**
 * Dashboard shell:
 *   Top bar: logo · client switcher · user
 *   Sidebar: Overview, Leads, Suppressions, Exports, Billing, Settings
 *
 * createClient() is inside the try/catch so a misconfigured or missing env var
 * redirects to /login instead of throwing an unhandled 500 for every dashboard
 * route.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let user: { id: string; email?: string | null } | null = null;
  let clients: { id: string; name: string; slug: string; plan: string }[] = [];

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.error('[dashboard/layout] getUser error:', error);
    } else {
      user = data.user;
    }

    if (user) {
      const { data: clientRows } = await supabase
        .from('clients')
        .select('id, name, slug, plan')
        .eq('owner_user', user.id)
        .order('created_at');
      clients = clientRows ?? [];
    }
  } catch (err) {
    console.error('[dashboard/layout] createClient/getUser threw:', err);
  }

  if (!user) redirect('/login');

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Top bar */}
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="font-semibold">OneClickitLeads</Link>
            <Suspense fallback={<div className="h-8 w-40 rounded-full bg-neutral-100" />}>
              <ClientSwitcher clients={clients} />
            </Suspense>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/pricing" className="text-neutral-600 hover:text-neutral-900">Pricing</Link>
            <span className="text-neutral-600 hidden md:inline">{user!.email}</span>
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
