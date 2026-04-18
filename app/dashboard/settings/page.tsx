import { createClient } from '@/utils/supabase/server';
import ApiKeyManager from '@/components/ApiKeyManager';
import WebhookManager from '@/components/WebhookManager';
import { planByTier } from '@/lib/plans';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: clients } = await supabase
    .from('clients').select('id, slug, name, plan').eq('owner_user', user.id);
  const active = (clients ?? []).find((c) => c.slug === sp.client) ?? clients?.[0];
  if (!active) return <div className="text-neutral-500">Create a client first.</div>;

  const plan = planByTier(active.plan);

  const [{ data: apiKeys }, { data: webhooks }] = await Promise.all([
    supabase.from('api_keys').select('id, key_prefix, label, last_used, created_at, revoked_at')
      .eq('client_id', active.id).order('created_at', { ascending: false }),
    supabase.from('webhooks').select('id, url, events, active, created_at')
      .eq('client_id', active.id).order('created_at', { ascending: false }),
  ]);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-neutral-600">Client: <strong>{active.name}</strong> — /{active.slug}</p>
      </div>

      {/* General */}
      <section className="rounded-xl border border-neutral-200 bg-white p-6">
        <h2 className="font-semibold">General</h2>
        <dl className="mt-4 grid md:grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div className="flex justify-between md:block">
            <dt className="text-neutral-500">Name</dt><dd className="font-medium">{active.name}</dd>
          </div>
          <div className="flex justify-between md:block">
            <dt className="text-neutral-500">Slug</dt><dd className="font-mono">{active.slug}</dd>
          </div>
          <div className="flex justify-between md:block">
            <dt className="text-neutral-500">Plan</dt><dd className="font-medium">{plan.name}</dd>
          </div>
          <div className="flex justify-between md:block">
            <dt className="text-neutral-500">Submit-lead URL</dt>
            <dd className="font-mono text-xs break-all">/submit-lead?client={active.slug}</dd>
          </div>
        </dl>
      </section>

      {/* API keys */}
      <section className="rounded-xl border border-neutral-200 bg-white p-6">
        <div className="flex justify-between items-start">
          <div>
            <h2 className="font-semibold">API keys</h2>
            <p className="text-sm text-neutral-600">Use these to hit /api/ingest and /api/push/smartly from your own systems.</p>
          </div>
          {!plan.features.apiAccess && (
            <span className="text-xs rounded-full bg-amber-50 text-amber-800 px-2 py-1">Growth or higher</span>
          )}
        </div>
        {plan.features.apiAccess ? (
          <ApiKeyManager clientSlug={active.slug} initial={apiKeys ?? []} />
        ) : (
          <div className="mt-4 text-sm text-neutral-500">
            Upgrade to Growth to enable server-to-server API access.
          </div>
        )}
      </section>

      {/* Webhooks */}
      <section className="rounded-xl border border-neutral-200 bg-white p-6">
        <div className="flex justify-between items-start">
          <div>
            <h2 className="font-semibold">Webhooks</h2>
            <p className="text-sm text-neutral-600">We'll POST signed payloads when exports complete or batches finish scrubbing.</p>
          </div>
        </div>
        <WebhookManager clientSlug={active.slug} initial={webhooks ?? []} />
      </section>

      {/* Danger zone */}
      <section className="rounded-xl border border-red-200 bg-red-50 p-6">
        <h2 className="font-semibold text-red-900">Danger zone</h2>
        <p className="text-sm text-red-800 mt-1">Deleting a client removes all leads, suppressions, and exports. This cannot be undone.</p>
        <form action={`/api/dashboard/clients/delete?slug=${active.slug}`} method="post" className="mt-4">
          <button
            className="rounded-full border border-red-300 bg-white text-red-700 px-4 py-2 text-sm hover:bg-red-100"
            type="submit"
          >
            Delete this client
          </button>
        </form>
      </section>
    </div>
  );
}
