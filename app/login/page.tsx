'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import SiteShell from '@/components/SiteShell';
import { createClient } from '@/utils/supabase/client';

function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next');
  const initialError = searchParams.get('error');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(initialError);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending');
    setErrorMsg(null);
    const supabase = createClient();
    const callbackPath = next
      ? `/auth/callback?next=${encodeURIComponent(next)}`
      : '/auth/callback';
    const redirectTo =
      typeof window !== 'undefined' ? `${window.location.origin}${callbackPath}` : undefined;

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) {
      setErrorMsg(error.message);
      setStatus('error');
    } else {
      setStatus('sent');
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 grid gap-4">
      <label className="grid gap-2">
        <span className="text-sm font-medium text-neutral-800">Work email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-neutral-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </label>
      <button
        type="submit"
        disabled={status === 'sending' || status === 'sent'}
        className="rounded-md bg-emerald-600 px-5 py-2.5 text-white font-medium hover:bg-emerald-700 disabled:opacity-50"
      >
        {status === 'sending' ? 'Sending link…' : status === 'sent' ? 'Check your inbox' : 'Send magic link'}
      </button>
      {status === 'sent' && (
        <p className="text-sm text-emerald-700">
          Sent. Click the link in the email to finish signing in.
        </p>
      )}
      {status === 'error' && <p className="text-sm text-red-600">{errorMsg}</p>}
    </form>
  );
}

export default function LoginPage() {
  return (
    <SiteShell>
      <section className="mx-auto max-w-md px-6 py-20">
        <h1 className="text-3xl font-semibold tracking-tight">Client login</h1>
        <p className="mt-2 text-neutral-600">
          We&apos;ll email you a one-click sign-in link. No password to remember.
        </p>

        <Suspense fallback={<div className="mt-8 h-32" />}>
          <LoginForm />
        </Suspense>

        <p className="mt-8 text-sm text-neutral-500">
          Need help?{' '}
          <Link href="/contact" className="underline">
            Contact us
          </Link>{' '}
          or email{' '}
          <a href="mailto:contact@oneclickit.ai" className="underline">
            contact@oneclickit.ai
          </a>
          .
        </p>
      </section>
    </SiteShell>
  );
}
