import Link from 'next/link';
import PricingGrid from '@/components/PricingGrid';

export default function Landing() {
  return (
    <main>
      {/* Nav */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-neutral-200">
        <div className="mx-auto max-w-6xl flex items-center justify-between px-6 py-4">
          <Link href="/" className="font-semibold tracking-tight text-lg">
            <span className="text-emerald-600">OneClick</span>itLeads
          </Link>
          <nav className="hidden md:flex gap-8 text-sm text-neutral-700">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#compliance">Compliance</a>
            <Link href="/dashboard" className="text-emerald-700 font-medium">
              Client login
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <p className="text-sm uppercase tracking-widest text-emerald-700 mb-3">
          Lead data, the clean way
        </p>
        <h1 className="text-5xl md:text-6xl font-semibold tracking-tight leading-tight">
          Scrubbed leads.<br />
          <span className="text-emerald-600">Delivered in one click.</span>
        </h1>
        <p className="mt-6 text-lg text-neutral-700 max-w-2xl">
          OneClickitLeads gathers, validates, and de-duplicates lead data, then
          exports it straight into smartly.io, Klaviyo, Meta, or CSV. Stop
          paying for bounces — only send to inboxes that open.
        </p>
        <div className="mt-8 flex flex-wrap gap-4">
          <Link
            href="/submit-lead"
            className="inline-flex items-center rounded-full bg-emerald-600 px-6 py-3 text-white font-medium hover:bg-emerald-700"
          >
            Start free audit
          </Link>
          <a
            href="#pricing"
            className="inline-flex items-center rounded-full border border-neutral-300 px-6 py-3 text-neutral-900 font-medium hover:bg-neutral-100"
          >
            See pricing
          </a>
        </div>
        <div className="mt-10 flex items-center gap-8 text-sm text-neutral-500">
          <span>✅ 97% deliverability target</span>
          <span>✅ CCPA + GDPR compliant</span>
          <span>✅ Ships in &lt; 15 min</span>
        </div>
      </section>

      {/* How */}
      <section id="how" className="border-t border-neutral-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-semibold mb-12">How it works</h2>
          <ol className="grid md:grid-cols-4 gap-8">
            {[
              ['Source', 'Pull from Apollo, Common Room, purchased lists, or ethical scraping of public directories.'],
              ['Scrub', 'Syntax + MX + SMTP check, dedupe, suppression filter — every lead passes 5 gates.'],
              ['Enrich', 'Hunter.io and Apollo fill the gaps: title, company, location, social.'],
              ['Export', 'One click to smartly.io Custom Audience, CSV, or your CRM via API.'],
            ].map(([t, d], i) => (
              <li key={t} className="relative">
                <div className="text-5xl font-semibold text-emerald-200">{i + 1}</div>
                <div className="mt-2 font-medium">{t}</div>
                <p className="mt-1 text-sm text-neutral-600">{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-neutral-200">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-semibold mb-2">Pricing</h2>
          <p className="text-neutral-600 mb-10">14-day free trial. Cancel anytime. No setup fees.</p>
          <PricingGrid />
          <div className="mt-8 text-center">
            <Link href="/pricing" className="text-emerald-700 font-medium hover:underline">
              Full plan comparison →
            </Link>
          </div>
        </div>
      </section>

      {/* Compliance */}
      <section id="compliance" className="border-t border-neutral-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-semibold mb-6">Compliance by default</h2>
          <div className="grid md:grid-cols-3 gap-8 text-sm text-neutral-700">
            <div>
              <div className="font-medium text-neutral-900">CCPA & GDPR aware</div>
              Every lead stores its source URL and ingestion timestamp. Deletion
              requests processed in ≤45 days.
            </div>
            <div>
              <div className="font-medium text-neutral-900">No dark patterns</div>
              Consent banner on every public form. Unsubscribes auto-flow into
              per-client suppression lists.
            </div>
            <div>
              <div className="font-medium text-neutral-900">Verified data only</div>
              No cold outreach from scraped-only sources without a verified
              opt-in signal. It's a hard rule, not a preference.
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-neutral-200 bg-neutral-50">
        <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-neutral-500 flex flex-wrap justify-between gap-4">
          <span>© {new Date().getFullYear()} OneClickitLeads — a Ritac Solutions product.</span>
          <div className="flex gap-6">
            <Link href="/privacy">Privacy</Link>
            <Link href="/data-request">Data request</Link>
            <a href="mailto:hello@oneclickitleads.com">Contact</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
