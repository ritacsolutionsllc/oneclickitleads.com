import Link from 'next/link';
import PricingGrid from '@/components/PricingGrid';

export const metadata = {
  title: 'Pricing — OneClickitLeads',
  description: 'Scrubbed business leads for any industry. Starter $49, Growth $199, Agency $499.',
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
            Every plan includes full scrubbing (syntax, MX, SMTP, dedupe, suppression) and a compliant audit trail.
            You pay for clean leads — not for bounces.
          </p>
        </div>

        <div className="mt-12">
          <PricingGrid />
        </div>

        {/* ICP Explainer */}
        <div className="mt-16 rounded-2xl border border-emerald-100 bg-emerald-50 p-8">
          <h2 className="text-xl font-semibold text-emerald-900">What is an ICP segment?</h2>
          <p className="mt-2 text-neutral-700 max-w-3xl">
            <strong>ICP stands for Ideal Customer Profile</strong> — the specific type of business you want to target
            with your outreach. Instead of buying a generic list, you define exactly which niche you want:
            salons, medspas, restaurants, real estate agents, gyms, auto dealers — whatever fits your product.
          </p>
          <p className="mt-3 text-neutral-700 max-w-3xl">
            Each plan includes a set number of active ICPs. On Starter you pick one niche and we fill it with
            verified leads. On Growth you can run four in parallel. On Agency and Enterprise, there are no limits —
            target any industry, any city, any combination.
          </p>
          <div className="mt-5 grid sm:grid-cols-3 gap-3 text-sm">
            {[
              { industry: 'Beauty & Wellness', examples: 'Hair salons, nail salons, medspas, lash bars, barbershops' },
              { industry: 'Fitness & Health', examples: 'Gyms, yoga studios, CrossFit boxes, chiropractors, dentists' },
              { industry: 'Food & Hospitality', examples: 'Restaurants, cafes, bakeries, food trucks, hotels, event venues' },
              { industry: 'Retail', examples: 'Beauty supply, boutique clothing, jewelry stores, sporting goods' },
              { industry: 'Professional Services', examples: 'Real estate agents, law firms, accountants, marketing agencies' },
              { industry: 'Home & Auto', examples: 'Contractors, cleaning services, landscapers, auto dealers, detailers' },
            ].map((row) => (
              <div key={row.industry} className="rounded-xl bg-white border border-emerald-100 p-4">
                <div className="font-medium text-emerald-900">{row.industry}</div>
                <div className="mt-1 text-xs text-neutral-500">{row.examples}</div>
              </div>
            ))}
          </div>
        </div>

        {/* What destinations mean */}
        <div className="mt-10 rounded-2xl border border-neutral-200 bg-white p-8">
          <h2 className="text-xl font-semibold">Where do your leads go?</h2>
          <p className="mt-2 text-neutral-600 max-w-3xl">
            You choose how to activate your list. Growth and Agency plans unlock direct integrations so you
            can push audiences without a manual upload step.
          </p>
          <div className="mt-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            {[
              { dest: 'CSV Export', desc: 'Download and import into any tool — Klaviyo, Mailchimp, Instantly, ActiveCampaign, your CRM.', plans: 'All plans' },
              { dest: 'smartly.io', desc: 'Push hashed audiences directly to smartly.io for automated paid-social campaigns.', plans: 'Growth+' },
              { dest: 'Meta CAPI', desc: 'Send SHA-256 hashed emails to Facebook/Instagram Custom Audiences via Conversions API.', plans: 'Growth+' },
              { dest: 'TikTok Ads', desc: 'Upload hashed audiences to TikTok Ads Manager for lookalike and retargeting campaigns.', plans: 'Agency+' },
              { dest: 'Klaviyo', desc: 'Sync leads directly into a Klaviyo list or segment — no CSV needed.', plans: 'Growth+' },
            ].map((row) => (
              <div key={row.dest} className="rounded-xl border border-neutral-100 bg-neutral-50 p-4">
                <div className="font-semibold text-neutral-900">{row.dest}</div>
                <div className="mt-1 text-xs text-neutral-500">{row.desc}</div>
                <div className="mt-2 text-xs font-medium text-emerald-700">{row.plans}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16 grid md:grid-cols-3 gap-6">
          <Feature
            title="No-questions refund"
            body="If an exported lead bounces, we credit it back. Our refund rate is under 2%."
          />
          <Feature
            title="First-party safe"
            body="Upload your Shopify customers and Klaviyo unsubs — they suppress automatically so you never re-spend on existing buyers."
          />
          <Feature
            title="Any industry, any city"
            body="Agency plans run custom scrapes: pick a city, a business type, and we pull fresh results from Google Places and enrich with Hunter.io."
          />
        </div>

        <div className="mt-20">
          <h2 className="text-2xl font-semibold text-center">Frequently asked</h2>
          <div className="mt-8 grid md:grid-cols-2 gap-6">
            <FAQ q="What exactly is an ICP segment?">
              ICP stands for Ideal Customer Profile — the specific type of business you want to reach.
              Examples: &quot;hair salons in Los Angeles&quot;, &quot;medspas nationwide&quot;, or
              &quot;real estate agents in Dallas TX&quot;. Each plan limits how many different ICPs you can
              run simultaneously. Agency and Enterprise have no limit.
            </FAQ>
            <FAQ q="Where does the data come from?">
              Google Places (business directories), Hunter.io (domain-search email enrichment), and our
              own web crawler that extracts contact emails from business websites. Agency plans can also
              pull from Apollo/Common Room. All sources are logged per lead for CCPA audits.
            </FAQ>
            <FAQ q="Which industries do you cover?">
              Any business category searchable on Google Maps — beauty, wellness, fitness, restaurants,
              retail, professional services, home services, automotive, healthcare, education, and more.
              Starter and Growth draw from our pre-built US database. Agency and Enterprise can scrape
              any query, city, or niche on demand.
            </FAQ>
            <FAQ q="How accurate are the emails?">
              Every lead passes syntax + MX + SMTP verification. The median bounce rate on exports is
              under 3% — compared to ~15% for unverified purchased lists.
            </FAQ>
            <FAQ q="Can I cancel any time?">
              Yes. Self-serve cancel in the Stripe customer portal. Your data stays exportable for
              30 days after cancellation.
            </FAQ>
            <FAQ q="What is custom scraping?">
              Agency and Enterprise plans let you run your own Google Places searches: enter any city
              (&quot;Austin TX&quot;), any query (&quot;CrossFit gym&quot; or &quot;law firm&quot;),
              and we pull up to 60 fresh results per run, crawl their websites for emails, enrich via
              Hunter, scrub the list, and push it to any destination — all in one click.
            </FAQ>
            <FAQ q="Can I white-label for my agency's clients?">
              Agency and Enterprise plans support white-label dashboards with your own domain + logo.
              Run it as your own product.
            </FAQ>
            <FAQ q="Do you support GDPR?">
              Yes — full DSAR support via /data-request, per-client consent tracking, and suppression.
              Enterprise plans include a signed DPA.
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
