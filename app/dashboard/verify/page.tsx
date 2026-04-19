import { createClient } from '@/utils/supabase/server';
import VerifyClient from './VerifyClient';

type SP = { searchParams: Promise<{ client?: string }> };

export default async function VerifyPage({ searchParams }: SP) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients')
    .select('id, slug, name')
    .eq('owner_user', user.id)
    .order('created_at');

  if (!clients || clients.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-semibold">Verify CSV</h1>
        <div className="mt-6 rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center text-sm text-neutral-500">
          Create a client first — we need a tenant to ingest the scrubbed leads into.
        </div>
      </div>
    );
  }

  const active = clients.find((c) => c.slug === sp.client) ?? clients[0];

  return (
    <div>
      <h1 className="text-2xl font-semibold">Verify CSV</h1>
      <p className="mt-2 text-sm text-neutral-600 max-w-2xl">
        Drop a CSV. We&apos;ll run every row through syntax, disposable, MX, and SMTP
        checks, plus dedupe + suppression, then score each lead and ingest it into
        the tenant. Download the cleaned CSV to paste into Smartleads.ai, or export
        the eligible rows from the Quality tab once the run finishes.
      </p>
      <VerifyClient
        clients={clients.map((c) => ({ slug: c.slug, name: c.name }))}
        defaultSlug={active.slug}
      />
    </div>
  );
}
