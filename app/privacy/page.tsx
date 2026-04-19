import Link from 'next/link';
import type { Metadata } from 'next';
import SiteShell from '@/components/SiteShell';

export const metadata: Metadata = {
  title: 'Privacy Policy — OneClickitLeads',
  description:
    'How OneClickitLeads collects, stores, and processes lead data. CCPA and GDPR compliance, data retention, and subject rights.',
};

const UPDATED = 'April 18, 2026';

export default function PrivacyPage() {
  return (
    <SiteShell>
      <article className="mx-auto max-w-3xl px-6 py-16 text-neutral-800">
        <h1 className="text-4xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <p className="mt-6 leading-relaxed">
          OneClickitLeads (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is a product of Ritac Solutions LLC. This policy
          explains what personal data we collect, why we collect it, how long we keep it,
          and the rights you have under the California Consumer Privacy Act (CCPA/CPRA)
          and the EU General Data Protection Regulation (GDPR).
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Data we collect</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Account data</strong> — name, email, and billing details when you sign
            up as a client (processed via Stripe; we do not store card numbers).
          </li>
          <li>
            <strong>Lead data</strong> — business names, public contact details (email,
            phone), and source URLs scraped from public directories (e.g. Google Places,
            OpenStreetMap, opt-in forms you own). Every record stores its{' '}
            <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs">source_url</code> and ingestion timestamp for audit.
          </li>
          <li>
            <strong>Usage data</strong> — minimal server logs (IP, user-agent, request
            path) for security and abuse prevention, retained for 30 days.
          </li>
        </ul>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Why we collect it</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed">
          <li>To deliver the lead-scrubbing service you or your client paid for.</li>
          <li>To meet legal obligations (tax records, opt-out honoring, audit trail).</li>
          <li>To secure the service against abuse.</li>
        </ul>
        <p className="mt-3 leading-relaxed">
          We do <strong>not</strong> sell personal information. We do not share data with
          advertisers or data brokers.
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Retention</h2>
        <p className="mt-3 leading-relaxed">
          Lead rows are retained for the duration of the client subscription plus 90 days,
          after which they are either deleted or anonymized. Suppression-list entries are
          retained indefinitely so that opt-outs are honored across subscription gaps.
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Your rights</h2>
        <p className="mt-3 leading-relaxed">Regardless of jurisdiction you may request that we:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed">
          <li>Confirm what personal data we hold about you.</li>
          <li>Provide a portable copy of that data.</li>
          <li>Correct inaccuracies.</li>
          <li>Delete your data (subject to legal retention obligations).</li>
          <li>Opt you out of any future processing.</li>
        </ul>
        <p className="mt-3 leading-relaxed">
          Submit a request via our{' '}
          <Link className="text-emerald-700 underline" href="/data-request">data request form</Link> or
          email{' '}
          <a className="text-emerald-700 underline" href="mailto:contact@oneclickit.ai">contact@oneclickit.ai</a>. We respond
          within 45 days (CCPA) / 30 days (GDPR).
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Subprocessors</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed">
          <li>Supabase (database + auth, US/EU)</li>
          <li>Stripe (billing, US)</li>
          <li>Vercel (hosting, US)</li>
          <li>Resend (transactional email, US)</li>
        </ul>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Security</h2>
        <p className="mt-3 leading-relaxed">
          Data is encrypted in transit (TLS 1.2+) and at rest. Access is limited to
          authenticated admins via row-level security policies. We do not export raw data
          off-platform except to the deliverability endpoints our clients explicitly
          configure (e.g. Smartly.io, Klaviyo).
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Contact</h2>
        <p className="mt-3 leading-relaxed">
          Privacy questions, complaints, or data requests:{' '}
          <a className="text-emerald-700 underline" href="mailto:contact@oneclickit.ai">contact@oneclickit.ai</a>.
        </p>
      </article>
    </SiteShell>
  );
}
