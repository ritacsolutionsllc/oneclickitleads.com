import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import {
  scoreLead,
  sourceTierFromKind,
  KNOWN_ICP_SEGMENTS,
} from '@/utils/quality/score';
import { hasValidSyntax, normalizeEmail } from '@/utils/scrub/email';
import { normalizePhone } from '@/utils/scrub/phone';

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
      ((formData.get('client_slug') as string) || '').trim().slice(0, 64) ||
      'chella';
    const emailRaw = ((formData.get('email') as string) || '')
      .trim()
      .slice(0, 254);
    const email = normalizeEmail(emailRaw);
    const first_name = ((formData.get('first_name') as string) || '')
      .trim()
      .slice(0, 80);
    const last_name = ((formData.get('last_name') as string) || '')
      .trim()
      .slice(0, 80);
    const phoneRaw = ((formData.get('phone') as string) || '').trim().slice(0, 32);
    const phone_e164 = phoneRaw ? normalizePhone(phoneRaw) : null;
    const icp_raw = ((formData.get('icp_segment') as string) || '').trim();
    const icp_segment = KNOWN_ICP_SEGMENTS.includes(icp_raw)
      ? icp_raw
      : 'b2c_beauty';

    if (!email || !first_name || !hasValidSyntax(email)) {
      redirect(
        `/submit-lead?client=${encodeURIComponent(slug)}&error=${encodeURIComponent('Please enter your first name and a valid email.')}`,
      );
    }

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

      const source_tier = sourceTierFromKind('firstparty');
      const quality = scoreLead({
        email,
        phone_e164,
        first_name,
        last_name,
        icp_segment,
        syntax_valid: true,
        // MX/SMTP are unverified at submit-time; an async reverify job
        // can upgrade this later and rerun scoring.
        mx_valid: false,
        smtp_valid: false,
        is_disposable: false,
        is_duplicate: false,
        is_suppressed: false,
        source_tier,
        verified_at: new Date(),
      });

      const { error: insertErr } = await supabase.from('leads').insert({
        client_id: client!.id,
        email,
        first_name,
        last_name: last_name || null,
        phone_e164,
        icp_segment,
        syntax_valid: true,
        is_scrubbed: false,
        quality_score: quality.quality_score,
        verification_status: quality.verification_status,
        source_tier,
        export_eligibility: quality.export_eligibility,
        reason_codes: quality.reason_codes,
        review_status: 'pending',
        raw: Object.fromEntries(formData.entries()),
      });

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
