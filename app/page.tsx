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
            <a href="#quality">Quality model</a>
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
          Quality-first lead data
        </p>
        <h1 className="text-5xl md:text-6xl font-semibold tracking-tight leading-tight">
          Every lead scored,<br />
          <span className="text-emerald-600">tiered, and explainable.</span>
        </h1>
        <p className="mt-6 text-lg text-neutral-700 max-w-2xl">
          Upload a messy CSV, get back a verified email list. Every record is
          scrubbed (syntax, MX, SMTP), scored 0–100, and stamped with the
          reason codes to back it up. Only eligible leads make it past the
          export gate — ready to paste into Smartleads.ai, Smartly.io, or your CRM.
        </p>
        <div className="mt-8 flex flex-wrap gap-4">
          <Link
            href="/dashboard/verify"
            className="inline-flex items-center rounded-full bg-emerald-600 px-6 py-3 text-white font-medium hover:bg-emerald-700"
          >
            Scrub my CSV
          </Link>
          <a
            href="#quality"
            className="inline-flex items-center rounded-full border border-neutral-300 px-6 py-3 text-neutral-900 font-medium hover:bg-neutral-100"
          >
            See the quality model
          </a>
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm text-neutral-500">
          <span>✅ CSV in, verified emails out</span>
          <span>✅ Deterministic scoring · no LLM randomness</span>
          <span>✅ CCPA + GDPR compliant</span>
        </div>
      </section>

      {/* CSV scrub callout */}
      <section className="border-t border-neutral-200 bg-emerald-50">
        <div className="mx-auto max-w-6xl px-6 py-16 grid md:grid-cols-[1.2fr_1fr] gap-10 items-center">
          <div>
            <p className="text-xs uppercase tracking-widest text-emerald-700 mb-2">New</p>
            <h2 className="text-2xl md:text-3xl font-semibold">
              Upload a CSV, get back a verified email list
            </h2>
            <p className="mt-3 text-neutral-700">
              Drop any list — Apollo export, trade-show scan, purchased file,
              scraped directory. We auto-detect the email column, run every
              row through syntax → MX → SMTP verification (NeverBounce /
              ZeroBounce), filter disposable domains, dedupe against your
              tenant, and return a cleaned CSV with the quality score and
              reason codes attached. Every valid row is also ingested into
              your dashboard so you can push straight to Smartleads.ai or
              Smartly.io.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/dashboard/verify"
                className="inline-flex items-center rounded-full bg-emerald-600 px-5 py-2.5 text-white font-medium hover:bg-emerald-700 text-sm"
              >
                Try the CSV verifier →
              </Link>
              <a
                href="#how"
                className="inline-flex items-center rounded-full border border-emerald-300 px-5 py-2.5 text-emerald-900 font-medium hover:bg-emerald-100 text-sm"
              >
                How the pipeline works
              </a>
            </div>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-white p-5 text-sm font-mono shadow-sm">
            <div className="text-xs uppercase tracking-wider text-neutral-500 mb-2">your_list.csv</div>
            <pre className="text-xs overflow-x-auto text-neutral-700">{`email,first_name,company
jane@realsalon.com,Jane,Real Salon
bob@mailinator.com,Bob,Test
typo@gmial.com,Typo,Oops
jane@realsalon.com,Jane,Real Salon`}</pre>
            <div className="mt-3 text-xs text-emerald-700">→ scrub + score</div>
            <div className="mt-3 text-xs uppercase tracking-wider text-neutral-500">verified.csv</div>
            <pre className="text-xs overflow-x-auto text-neutral-700">{`email,quality_score,eligibility,reason_codes
jane@realsalon.com,88,eligible,ID_SMTP_VERIFIED;ICP_MATCH
bob@mailinator.com,0,rejected,REJECT_DISPOSABLE
typo@gmial.com,0,rejected,REJECT_BAD_SYNTAX
(duplicate removed)`}</pre>
          </div>
        </div>
      </section>

      {/* How */}
      <section id="how" className="border-t border-neutral-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-semibold mb-12">How it works</h2>
          <ol className="grid md:grid-cols-4 gap-8">
            {[
              ['Source',   'Pull from first-party forms, paid APIs (Apollo, Hunter), verified directories, or ethical scraping. Every source is tagged A/B/C/D.'],
              ['Verify',   'Syntax → MX → SMTP ladder, plus disposable, duplicate, and suppression filters. Verification status is stored on the row.'],
              ['Score',    '0–100 quality score across identity, completeness, source tier, ICP fit, freshness, and intent. Every point is explainable.'],
              ['Gate',     'Exports only read leads tagged eligible. Borderline rows go to the review queue; hard rejects never reach a client.'],
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

      {/* Quality model */}
      <section id="quality" className="border-t border-neutral-200">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-semibold mb-2">The quality model</h2>
          <p className="text-neutral-600 mb-10 max-w-2xl">
            Every lead is scored on six dimensions. The score is deterministic —
            the same input always produces the same output — and the reason
            codes travel with the record into the dashboard and the CSV.
          </p>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { w: 35, t: 'Identity',      d: 'Syntax + MX + SMTP + first-party opt-in signal. Disposable and role-only addresses are hard rejects.' },
              { w: 20, t: 'Source tier',   d: 'A = first-party, B = paid API, C = verified directory, D = open-web scrape. Tier D without SMTP verification routes to review.' },
              { w: 15, t: 'Completeness', d: 'Name, company, title, geo, phone. Sparse profiles land in review, not the export file.' },
              { w: 15, t: 'ICP fit',       d: 'Matched against the client\'s Ideal Customer Profile segments and tag signals. No ICP → no export.' },
              { w: 10, t: 'Freshness',     d: 'Age-weighted: ≤7d full credit, ≤90d partial, >180d stale. Stale leads requeue for re-verify before export.' },
              { w: 5,  t: 'Intent',        d: 'Behavioral or explicit intent signals (form fills, event triggers) push borderline leads over the line.' },
            ].map((r) => (
              <div key={r.t} className="rounded-xl border border-neutral-200 bg-white p-5">
                <div className="flex items-baseline justify-between">
                  <div className="font-medium">{r.t}</div>
                  <div className="text-xs text-neutral-500">weight {r.w}</div>
                </div>
                <p className="mt-2 text-sm text-neutral-600">{r.d}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 rounded-xl border border-neutral-200 bg-white p-6">
            <div className="font-medium mb-3">Eligibility verdict</div>
            <div className="grid md:grid-cols-4 gap-4 text-sm">
              <Verdict color="emerald" label="Eligible"   hint="Score ≥70, verified, ICP match — ready to export." />
              <Verdict color="amber"   label="In review"  hint="40–69 score or scraped & unverified — operator decides." />
              <Verdict color="orange"  label="Quarantine" hint="Under 40 or no contact surface — safe to reject." />
              <Verdict color="red"     label="Rejected"   hint="Disposable, bad syntax, suppressed, or duplicate." />
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-neutral-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-semibold mb-2">Pricing</h2>
          <p className="text-neutral-600 mb-10">Billed on eligible leads, not raw volume. 14-day free trial. Cancel anytime.</p>
          <PricingGrid />
          <div className="mt-8 text-center">
            <Link href="/pricing" className="text-emerald-700 font-medium hover:underline">
              Full plan comparison →
            </Link>
          </div>
        </div>
      </section>

      {/* Compliance */}
      <section id="compliance" className="border-t border-neutral-200">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-semibold mb-6">Compliance by default</h2>
          <div className="grid md:grid-cols-3 gap-8 text-sm text-neutral-700">
            <div>
              <div className="font-medium text-neutral-900">Provenance on every row</div>
              Source tier, source URL, verification status, and ingestion
              timestamp are stored with every lead. DSAR requests processed in ≤45 days.
            </div>
            <div>
              <div className="font-medium text-neutral-900">No dark patterns</div>
              Consent banner on every public form. Unsubscribes auto-flow into
              per-client suppression lists and become hard rejects at the gate.
            </div>
            <div>
              <div className="font-medium text-neutral-900">Verified or bust</div>
              Scraped leads without SMTP verification never export automatically
              — they route to the review queue. It&apos;s a hard rule, not a preference.
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
            <Link href="/contact">Contact</Link>
            <a href="mailto:contact@oneclickit.ai">contact@oneclickit.ai</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Verdict({
  color,
  label,
  hint,
}: {
  color: 'emerald' | 'amber' | 'orange' | 'red';
  label: string;
  hint: string;
}) {
  const cls = {
    emerald: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    amber:   'border-amber-300   bg-amber-50   text-amber-900',
    orange:  'border-orange-300  bg-orange-50  text-orange-900',
    red:     'border-red-300     bg-red-50     text-red-900',
  }[color];
  return (
    <div className={`rounded-lg border px-4 py-3 ${cls}`}>
      <div className="font-medium">{label}</div>
      <p className="mt-1 text-xs opacity-80">{hint}</p>
    </div>
  );
}
