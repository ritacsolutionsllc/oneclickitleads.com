'use client';

import { useEffect } from 'react';

/**
 * Catches any thrown error inside /dashboard/** and renders a readable
 * fallback. Without this, a stray throw in a server component shows the
 * generic Next.js error page with only a digest.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[dashboard] unhandled error:', error);
  }, [error]);

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6">
      <h2 className="text-lg font-semibold text-red-900">
        Something went wrong loading this page
      </h2>
      <p className="mt-2 text-sm text-red-800">
        {error.message || 'An unexpected error occurred.'}
        {error.digest && (
          <span className="ml-2 font-mono text-xs text-red-700">({error.digest})</span>
        )}
      </p>
      <div className="mt-4 flex gap-3">
        <button
          onClick={() => reset()}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
        >
          Try again
        </button>
        <a
          href="/dashboard"
          className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-100"
        >
          Back to dashboard
        </a>
      </div>
    </div>
  );
}
