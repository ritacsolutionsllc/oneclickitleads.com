'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app/error]', error);
  }, [error]);

  return (
    <section className="mx-auto max-w-xl px-6 py-24 text-center">
      <p className="text-sm font-medium text-red-600">Something went wrong</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">
        We hit an unexpected error
      </h1>
      <p className="mt-4 text-neutral-600">
        The team has been notified. You can try again, head home, or reach out
        if this keeps happening.
      </p>
      {error.digest && (
        <p className="mt-3 text-xs text-neutral-400">Reference: {error.digest}</p>
      )}
      <div className="mt-8 flex flex-wrap justify-center gap-3 text-sm">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-700"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-100"
        >
          Back to home
        </Link>
        <a
          href="mailto:contact@oneclickit.ai"
          className="rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-100"
        >
          Email support
        </a>
      </div>
    </section>
  );
}
