import { createAdminClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { scrubBatch, scoringInsertFields } from '@/utils/scrub/pipeline';
import { loadClientContext } from '@/utils/scoring/client-context';

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
    const consent = formData.get('consent') === 'on';

    if (!email || !first_name) {
      redirect(
        `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('Please enter your first name and email.')}`,
      );
    }
    if (!consent) {
      redirect(
        `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('Please agree to receive marketing emails.')}`,
      );
    }

    try {
      // Public consent form — there is no authenticated session, so the user-
      // scoped SSR client would see zero rows under RLS. Use the service role
      // client scoped to this specific slug; nothing in the form writes a
      // client-chosen `client_id`.
      const supabase = createAdminClient();

      const ctx = await loadClientContext(supabase, slug);
      if (!ctx) {
        redirect(
          `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('This signup link is no longer active.')}`,
        );
      }

      // Record the consent form as a first-party source so the audit trail
      // can distinguish opt-ins from purchased / scraped rows.
      const { data: src } = await supabase
        .from('sources')
        .insert({
          client_id: ctx!.id,
          kind: 'firstparty',
          label: 'consent form: /submit-lead',
          source_url: '/submit-lead',
          trust_tier: 1,
        })
        .select('id')
        .single();

      const [scrubbed] = await scrubBatch(
        supabase,
        ctx!.id,
        [
          {
            email,
            phone: phone || undefined,
            first_name,
            last_name: last_name || undefined,
            icp_segment,
          },
        ],
        {
          doEnrich: false, // don't burn Hunter credits on B2C consent forms
          sourceTrustTier: 1,
          clientIcpTargets: ctx!.icpTargets,
          exportPolicy: ctx!.exportPolicy,
        },
      );

      // Duplicates and suppressed rows still write (with the appropriate
      // reject_reason + tier='discard'), so Keaton can see attempted re-signups
      // in the audit log rather than silently swallowing them.
      const { error: insertErr } = await supabase.from('leads').upsert(
        {
          client_id: ctx!.id,
          source_id: src?.id,
          email: scrubbed.normalized_email,
          first_name: scrubbed.first_name,
          last_name: scrubbed.last_name,
          phone_e164: scrubbed.phone_e164,
          icp_segment,
          tags: ['consent_form', 'opted_in'],
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
        },
        { onConflict: 'client_id,email_hash', ignoreDuplicates: true },
      );

      if (insertErr) {
        console.error('[submit-lead] insert failed:', insertErr);
        redirect(
          `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('We could not save your signup. Please try again.')}`,
        );
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
