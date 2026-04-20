import { createClient, createAdminClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { scrubEmail } from '@/utils/scrub/email';
import { normalizePhone } from '@/utils/scrub/phone';
import { qualityColumns, scoreLead } from '@/utils/quality/score';
import type { ScrubbedLead } from '@/utils/scrub/pipeline';

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

      // Public form opt-in: an anonymous user is supplying their own
      // contact info, so this is first-party data with explicit consent.
      // We still run the email through the scrub ladder — a typo'd
      // address must not leak past the export gate just because a human
      // typed it. The admin client writes the source row + score so the
      // public-facing supabase session never gains write access to
      // sources/leads beyond the existing RLS policy.
      const emailResult = await scrubEmail(email);
      const phoneE164 = phone ? normalizePhone(phone) : null;
      const synthetic: ScrubbedLead = {
        first_name,
        last_name: last_name || undefined,
        email,
        phone: phoneE164 ?? undefined,
        icp_segment,
        normalized_email: emailResult.normalized,
        phone_e164: phoneE164,
        syntax_valid: emailResult.syntax_valid,
        mx_valid: emailResult.mx_valid,
        smtp_valid: emailResult.smtp_valid,
        is_disposable: emailResult.is_disposable,
        is_duplicate: false,
        is_suppressed: false,
        scrub_score: emailResult.score,
        reject_reason: emailResult.reject_reason,
        is_scrubbed:
          emailResult.syntax_valid &&
          emailResult.mx_valid &&
          !emailResult.is_disposable,
        quality: undefined as never,
      };
      const quality = scoreLead({
        scrubbed: synthetic,
        sourceTier: 'first_party',
        signals: { first_party: true, verified_at: new Date().toISOString() },
      });

      // sources/leads writes go through the admin client because the
      // public form runs without an authenticated supabase session and
      // RLS policies on those tables key off `auth.uid()`.
      const admin = createAdminClient();

      const { data: src } = await admin
        .from('sources')
        .insert({
          client_id: client!.id,
          kind: 'first_party',
          tier: 'first_party',
          label: `submit-lead opt-in (${icp_segment})`,
          source_url: '/submit-lead',
        })
        .select('id')
        .single();

      const { error: insertErr } = await admin.from('leads').insert({
        client_id: client!.id,
        source_id: src?.id ?? null,
        email: emailResult.normalized,
        first_name,
        last_name: last_name || null,
        phone_e164: phoneE164,
        icp_segment,
        syntax_valid: emailResult.syntax_valid,
        mx_valid: emailResult.mx_valid,
        smtp_valid: emailResult.smtp_valid,
        is_disposable: emailResult.is_disposable,
        scrub_score: emailResult.score,
        reject_reason: emailResult.reject_reason ?? null,
        is_scrubbed: synthetic.is_scrubbed,
        scrubbed_at: new Date().toISOString(),
        raw: Object.fromEntries(formData.entries()),
        ...qualityColumns(quality),
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
