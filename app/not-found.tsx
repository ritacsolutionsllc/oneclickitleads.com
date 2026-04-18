import Link from 'next/link';
import SiteShell from '@/components/SiteShell';

export const metadata = {
  title: 'Page not found — OneClickitLeads',
};

export default function NotFound() {
  return (
    <SiteShell>
      <section className="mx-auto max-w-xl px-6 py-24 text-center">
        <p className="text-sm font-medium text-emerald-600">404</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">
          We couldn&apos;t find that page
        </h1>
        <p className="mt-4 text-neutral-600">
          The link may be stale or the page may have moved. Try one of these:
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3 text-sm">
          <Link
            href="/"
            className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-700"
          >
            Back to home
          </Link>
          <Link
            href="/pricing"
            className="rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-100"
          >
            Pricing
          </Link>
          <Link
            href="/contact"
            className="rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-100"
          >
            Contact us
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}
