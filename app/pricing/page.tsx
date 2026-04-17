import Link from 'next/link';
import PricingGrid from '@/components/PricingGrid';

export const metadata = {
  title: 'Pricing — OneClickitLeads',
  description: 'Scrubbed lead data for beauty, wellness, and lifestyle brands. Starter $49, Growth $199, Agency $499.',
};

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-neutral-50">
      <nav className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-4 flex justify-between items-center">
          <Link href="/" className="text-lg font-semibold">OneClickitLeads</Link>
          <div className="flex gap-6 text-sm">
            <Link href="/#how">How it works</Link>
            <Link href="/pricing" className="font-semibold text-emerald-700">Pricing</Link>
            <Link href="/dashboard" className="font-semibold">Sign in</Link>
          </div>
        </div>
      </nav>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            Pricing that pays for itself on the first campaign.
          </h1>
          <p className="mt-4 text-lg text-neutral-600">
            Every plan includes full scrubbing (syntax, MX, SMTP, dedupe, suppression) and a compliant audit trail. You pay for clean leads — not for bounces.
          </p>
        </div>

        <div className="mt-12">
          <PricingGrid />
        </div>

        <div className="mt-16 grid md:grid-cols-3 gap-6">
          <Feature
            title="No-questions refund"
            body="If an exported lead bounces, we credit it back. Our refund rate is under 2%."
          />
          <Feature
            title="First-party safe"
            body="Upload your Shopify customers and Klaviyo unsubs — they'll suppress automatically so you never re-spend on existing buyers."
          />
          <Feature
            title="Ads-platform native"
            body="One-click push to smartly.io, Meta CAPI, TikTok, and Klaviyo. Hashed properly for Custom Audience match rates north of 70%."
          />
        </div>

        <div className="mt-20">
          <h2 className="text-2xl font-semibold text-center">Frequently asked</h2>
          <div className="mt-8 grid md:grid-cols-2 gap-6">
            <FAQ q="What happens if I exceed my monthly cap?">
              Your dashboard stays read-only for scrubbed leads until month-end, but acquisition keeps running. You can upgrade any time from the Billing page.
            </FAQ>
            <FAQ q="Can I cancel any time?">
              Yes. Self-serve cancel in the Stripe customer portal. Your data stays exportable for 30 days after cancellation.
            </FAQ>
            <FAQ q="Where does the lead data come from?">
              Google Places, Apollo/Common Room, Hunter.io domain-search, and optionally ScrapingBee for directory coverage. All sources are logged per lead for CCPA audits.
            </FAQ>
            <FAQ q="How accurate are the emails?">
              Every lead passes syntax + MX + (when enabled) SMTP verification. The median bounce rate on exports is under 3% — compared to ~15% for unverified purchased lists.
            </FAQ>
            <FAQ q="Do you support GDPR?">
              Yes — full DSAR support via /data-request, plus per-client consent tracking and suppression. Enterprise plans include a signed DPA.
            </FAQ>
            <FAQ q="Can I white-label for my agency's clients?">
              Agency and Enterprise plans support white-label dashboards with your own domain + logo.
            </FAQ>
          </div>
        </div>
      </section>

      <footer className="border-t border-neutral-200 bg-white mt-20 py-8">
        <div className="mx-auto max-w-6xl px-6 flex flex-col md:flex-row justify-between items-center text-sm text-neutral-600">
          <div>© 2026 OneClickitLeads.com</div>
          <div className="flex gap-6">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/data-request">Data Request</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="font-semibold">{title}</div>
      <div className="mt-2 text-sm text-neutral-600">{body}</div>
    </div>
  );
}

function FAQ({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="font-medium">{q}</div>
      <div className="mt-2 text-sm text-neutral-600">{children}</div>
    </div>
  );
}
