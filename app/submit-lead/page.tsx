import { createClient } from '@/utils/supabase/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

type SearchParams = { client?: string; error?: string; ok?: string };

// Bump whenever the consent checkbox copy below changes. The previous
// string stays tied to leads that consented to *that* version via
// leads.consent_text_version, so proofs remain attributable.
const CONSENT_TEXT_VERSION = '2026-04-22a';
const CONSENT_TEXT =
  'I agree to receive marketing emails and understand I can unsubscribe at any time.';

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

    const consented = formData.get('consent') === 'on';
    if (!email || !first_name) {
      redirect(
        `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('Please enter your first name and email.')}`,
      );
    }
    if (!consented) {
      redirect(
        `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('You must agree to receive emails before submitting.')}`,
      );
    }

    // Capture proof-of-consent headers server-side. The browser can't
    // forge these without also bypassing the form, and `x-forwarded-for`
    // on Vercel is set by the edge — not trusted for auth, but accurate
    // enough for a compliance audit trail.
    const h = await headers();
    const consent_ip =
      (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ||
      h.get('x-real-ip') ||
      null;
    const consent_ua = h.get('user-agent')?.slice(0, 500) ?? null;
    const consent_ts = new Date().toISOString();
    const consent_source_url =
      h.get('referer') ??
      `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/submit-lead?client=${encodeURIComponent(slug)}`;

    try {
      const supabase = await createClient();

      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();

      if (clientErr) {
        console.error('[submit-lead] client lookup failed:', clientErr);
        redirect(
          `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('Something went wrong on our end. Please try again.')}`,
        );
      }

      if (!client) {
        redirect(
          `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('This signup link is no longer active.')}`,
        );
      }

      const { data: inserted, error: insertErr } = await supabase
        .from('leads')
        .insert({
          client_id: client!.id,
          email,
          first_name,
          last_name: last_name || null,
          phone_e164: phone || null,
          icp_segment,
          consent_ts,
          consent_ip,
          consent_ua,
          consent_text_version: CONSENT_TEXT_VERSION,
          consent_source_url,
          raw: {
            ...Object.fromEntries(formData.entries()),
            consent_text: CONSENT_TEXT,
          },
        })
        .select('id')
        .single();

      if (insertErr) {
        console.error('[submit-lead] insert failed:', insertErr);
        redirect(
          `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('We could not save your signup. Please try again.')}`,
        );
      }

      // Immutable audit row so the proof URL has something to render even
      // if the lead row is later deleted via DSAR.
      if (inserted?.id) {
        await supabase.from('lead_events').insert({
          lead_id: inserted.id,
          kind: 'consented',
          detail: {
            ts: consent_ts,
            ip: consent_ip,
            ua: consent_ua,
            text_version: CONSENT_TEXT_VERSION,
            text: CONSENT_TEXT,
            source_url: consent_source_url,
          },
        });
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
          <span>
            {CONSENT_TEXT} See the{' '}
            <a className="underline" href="/privacy">
              privacy policy
            </a>
            .
          </span>
        </label>
        <input
          type="hidden"
          name="consent_text_version"
          defaultValue={CONSENT_TEXT_VERSION}
        />

        <button className="w-full rounded-full bg-emerald-600 text-white py-3 font-medium hover:bg-emerald-700">
          Submit
        </button>
      </form>
    </main>
  );
}
