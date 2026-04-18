import type { Metadata } from 'next';
import SiteShell from '@/components/SiteShell';

export const metadata: Metadata = {
  title: 'Terms of Service — OneClickitLeads',
  description:
    'Terms governing your use of OneClickitLeads — a Ritac Solutions product for scrubbed lead data and performance marketing integrations.',
};

export default function TermsPage() {
  const updated = new Date('2026-04-18').toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <SiteShell>
      <article className="mx-auto max-w-3xl px-6 py-16 prose prose-neutral">
        <h1 className="text-4xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="text-sm text-neutral-500">Last updated: {updated}</p>

        <p className="mt-6">
          These Terms govern your access to and use of OneClickitLeads (the
          &ldquo;Service&rdquo;), operated by Ritac Solutions LLC
          (&ldquo;we,&rdquo; &ldquo;us&rdquo;). By creating an account or using
          the Service you agree to be bound by these Terms.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">1. The service</h2>
        <p>
          OneClickitLeads helps you gather, scrub, deduplicate, and export
          lead data to advertising and marketing platforms. We are a
          processor of the data you upload; you remain the controller.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">2. Your responsibilities</h2>
        <ul>
          <li>You warrant that you have the legal right to process every
            lead you upload, including a lawful basis under GDPR where
            applicable and consent where required by CCPA/CAN-SPAM/TCPA.</li>
          <li>You will not upload data you obtained by scraping sites whose
            terms prohibit it, nor data belonging to minors, nor any data
            covered by HIPAA, GLBA, or similar restricted regimes.</li>
          <li>You are responsible for keeping your credentials secure and
            for all activity under your account.</li>
        </ul>

        <h2 className="mt-10 text-2xl font-semibold">3. Acceptable use</h2>
        <p>
          You may not use the Service to send unsolicited commercial email,
          to target individuals who have opted out, or to circumvent the
          rate limits and scrub pipeline. We may suspend accounts we
          reasonably believe are violating this section.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">4. Plans and billing</h2>
        <p>
          Paid plans are billed in advance via Stripe on a monthly or annual
          basis. Self-serve subscriptions auto-renew until cancelled from the
          billing portal. Refunds are issued at our discretion for
          unintentional duplicate charges or outages we caused.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">5. Data and privacy</h2>
        <p>
          Our handling of personal data is described in the{' '}
          <a href="/privacy">Privacy Policy</a>. Data subjects can exercise
          CCPA/GDPR rights through the <a href="/data-request">Data Request</a>
          {' '}form.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">6. Warranty disclaimer</h2>
        <p>
          The Service is provided &ldquo;as is.&rdquo; We do not warrant that
          scrubbed data will be 100% deliverable — email, phone, and postal
          deliverability depend on upstream providers and change over time.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">7. Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, our aggregate liability for
          any claim arising out of the Service is limited to the fees you
          paid us in the twelve months preceding the claim. We are not
          liable for indirect, incidental, or consequential damages.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">8. Termination</h2>
        <p>
          You may cancel at any time. We may suspend or terminate your
          access for material breach of these Terms or for non-payment.
          On termination we will delete your data within 30 days, subject to
          legal retention requirements.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">9. Changes</h2>
        <p>
          We may update these Terms from time to time. Material changes
          will be announced via email at least 14 days before taking
          effect.
        </p>

        <h2 className="mt-10 text-2xl font-semibold">10. Contact</h2>
        <p>
          Questions about these Terms?{' '}
          <a href="mailto:contact@oneclickit.ai">contact@oneclickit.ai</a>.
        </p>
      </article>
    </SiteShell>
  );
}
