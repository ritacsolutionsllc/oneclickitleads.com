import { createAdminClient, createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { scrubBatch, scoringInsertFields } from '@/utils/scrub/pipeline';
import { loadClientScoringContextBySlug } from '@/utils/scoring/client-context';
import { trustTierForSource } from '@/utils/scoring/sources';

type SearchParams = { client?: string; error?: string; ok?: string };

export default async function SubmitLead({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  async function submit(formData: FormData) {
    'use server';

    const slug =
      ((formData.get('client_slug') as string) || '').trim() || 'chella';
    const email = ((formData.get('email') as string) || '')
      .trim()
      .toLowerCase();
    const first_name = ((formData.get('first_name') as string) || '').trim();
    const last_name = ((formData.get('last_name') as string) || '').trim();
    const phone = ((formData.get('phone') as string) || '').trim();
    const icp_segment =
      ((formData.get('icp_segment') as string) || '').trim() || 'b2c_beauty';

    if (!email || !first_name) {
      redirect(
        `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('Please enter your first name and email.')}`,
      );
    }

    try {
      // Use the admin client so the scrub pipeline can read suppressions
      // and existing email_hash values without RLS noise on a public form.
      // The auth-scoped client is used only to check that the tenant exists.
      const userClient = await createClient();
      const { data: clientLookup, error: clientErr } = await userClient
        .from('clients')
        .select('id, slug')
        .eq('slug', slug)
        .maybeSingle();

      if (clientErr) {
        console.error('[submit-lead] client lookup failed:', clientErr);
        redirect(
          `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('Something went wrong on our end. Please try again.')}`,
        );
      }

      if (!clientLookup) {
        redirect(
          `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('This signup link is no longer active.')}`,
        );
      }

      const supabase = createAdminClient();
      const ctx = await loadClientScoringContextBySlug(supabase, slug);
      const sourceTrustTier = trustTierForSource('optin');

      // Record the source so the lead has lineage. Public opt-in forms are
      // first-party (consent + traceable to the form submission).
      const { data: src } = await supabase
        .from('sources')
        .insert({
          client_id: clientLookup!.id,
          kind: 'optin',
          label: `submit-lead form (${icp_segment})`,
          source_url: '/submit-lead',
          trust_tier: sourceTrustTier,
        })
        .select('id')
        .single();

      const [scrubbed] = await scrubBatch(
        supabase,
        clientLookup!.id,
        [
          {
            email,
            phone: phone || undefined,
            first_name,
            last_name: last_name || undefined,
            icp_segment,
            source_url: '/submit-lead',
            tags: ['optin', 'submit-lead'],
          },
        ],
        {
          doEnrich: false,
          sourceTrustTier,
          clientIcpTargets: ctx?.icpTargets ?? [],
          exportPolicy: ctx?.exportPolicy ?? null,
        }
      );

      // Silently ack duplicates and suppressed addresses — both produce the
      // same UX (we already have the user, or they previously opted out).
      // Skip the insert in those cases so the unique index doesn't throw.
      if (!scrubbed.is_duplicate && !scrubbed.is_suppressed) {
        const { error: insertErr } = await supabase.from('leads').insert({
          client_id: clientLookup!.id,
          source_id: src?.id ?? null,
          email: scrubbed.normalized_email || email,
          first_name: scrubbed.first_name ?? first_name,
          last_name: scrubbed.last_name ?? (last_name || null),
          phone_e164: scrubbed.phone_e164,
          icp_segment,
          tags: scrubbed.tags ?? [],
          is_scrubbed: scrubbed.is_scrubbed,
          syntax_valid: scrubbed.syntax_valid,
          mx_valid: scrubbed.mx_valid,
          smtp_valid: scrubbed.smtp_valid,
          is_disposable: scrubbed.is_disposable,
          is_duplicate: scrubbed.is_duplicate,
          is_suppressed: scrubbed.is_suppressed,
          scrub_score: scrubbed.scrub_score,
          reject_reason: scrubbed.reject_reason,
          ...scoringInsertFields(scrubbed),
          raw: Object.fromEntries(formData.entries()),
          scrubbed_at: new Date().toISOString(),
        });

        if (insertErr) {
          console.error('[submit-lead] insert failed:', insertErr);
          redirect(
            `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('We could not save your signup. Please try again.')}`,
          );
        }
      }
    } catch (err) {
      // `redirect()` throws internally — let it through.
      // Next.js marks these with NEXT_REDIRECT. Re-throwing preserves the redirect.
      if (
        err &&
        typeof err === 'object' &&
        'digest' in err &&
        typeof (err as { digest?: string }).digest === 'string' &&
        (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
      ) {
        throw err;
      }
      console.error('[submit-lead] unexpected error:', err);
      redirect(
        `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('Something went wrong. Please try again.')}`,
      );
    }

    redirect(
      `/submit-lead?client=${encodeURIComponent(slug)}&ok=1`,
    );
  }

  const clientSlug = sp.client ?? 'chella';
  const errorMsg = sp.error;
  const success = sp.ok === '1';

  if (success) {
    return (
      <main className="mx-auto max-w-lg px-6 py-16">
        <h1 className="text-3xl font-semibold">You&apos;re on the list 🎉</h1>
        <p className="text-neutral-600 mt-3">
          Thanks — check your inbox for a confirmation from the brand.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <h1 className="text-3xl font-semibold">Join the list</h1>
      <p className="text-neutral-600 mt-2">
        We use your info only to send you offers from the brand you&apos;re
        signing up with. Unsubscribe any time.
      </p>

      {errorMsg && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {errorMsg}
        </div>
      )}

      <form action={submit} className="mt-8 space-y-4">
        <input type="hidden" name="client_slug" defaultValue={clientSlug} />

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-neutral-700">First name</span>
            <input
              required
              name="first_name"
              className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2"
            />
          </label>
          <label className="block">
            <span className="text-sm text-neutral-700">Last name</span>
            <input
              name="last_name"
              className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm text-neutral-700">Email</span>
          <input
            required
            type="email"
            name="email"
            className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-700">Phone (optional)</span>
          <input
            name="phone"
            className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-700">I am a...</span>
          <select
            name="icp_segment"
            className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2 bg-white"
          >
            <option value="b2c_beauty">Beauty shopper</option>
            <option value="salon">Salon / spa owner</option>
            <option value="retailer">Retailer / buyer</option>
            <option value="influencer">Creator / influencer</option>
          </select>
        </label>

        <label className="flex items-start gap-2 text-xs text-neutral-600">
          <input required type="checkbox" name="consent" className="mt-1" />
          I agree to receive marketing emails and understand I can unsubscribe
          at any time. See the{' '}
          <a className="underline" href="/privacy">
            privacy policy
          </a>
          .
        </label>

        <button className="w-full rounded-full bg-emerald-600 text-white py-3 font-medium hover:bg-emerald-700">
          Submit
        </button>
      </form>
    </main>
  );
}
