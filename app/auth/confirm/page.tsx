'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import SiteShell from '@/components/SiteShell';

function ConfirmContent() {
  const params = useSearchParams();
  const router = useRouter();
  const tokenHash = params.get('token_hash') ?? '';
  const type = params.get('type') ?? 'email';
  const next = params.get('next') ?? '/dashboard';
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const valid = !!tokenHash;

  async function handleSignIn() {
    if (!valid) return;
    setStatus('loading');
    setErrorMsg('');
    try {
      const res = await fetch('/api/auth/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_hash: tokenHash, type, next }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error ?? 'Sign-in failed. The link may have expired.');
        setStatus('error');
      } else {
        router.replace(data.next ?? '/dashboard');
      }
    } catch {
      setErrorMsg('Something went wrong. Please try again.');
      setStatus('error');
    }
  }

  if (!valid) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Link expired or invalid</h1>
        <p className="mt-2 text-neutral-600">
          This sign-in link has already been used or is invalid. Request a new one below.
        </p>
        <div className="mt-8">
          <Link
            href="/login"
            className="inline-block rounded-md bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Back to login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-2xl font-semibold tracking-tight">One tap to sign in</h1>
      <p className="mt-2 text-neutral-600">
        Click below to confirm your identity and access your dashboard.
      </p>

      <div className="mt-8">
        <button
          onClick={handleSignIn}
          disabled={status === 'loading'}
          className="w-full max-w-xs rounded-md bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          {status === 'loading' ? 'Signing in…' : 'Sign in to OneClickIT Leads'}
        </button>
      </div>

      {status === 'error' && (
        <div className="mt-5 grid gap-2">
          <p className="text-sm text-red-600">{errorMsg}</p>
          <Link href="/login" className="text-sm text-emerald-700 underline">
            Request a new link
          </Link>
        </div>
      )}

      {status === 'idle' && (
        <p className="mt-4 text-xs text-neutral-400">
          This link expires after one use.{' '}
          <Link href="/login" className="underline">
            Resend
          </Link>
        </p>
      )}
    </div>
  );
}

export default function ConfirmPage() {
  return (
    <SiteShell>
      <section className="mx-auto max-w-md px-6 py-20">
        <Suspense fallback={<div className="h-32" />}>
          <ConfirmContent />
        </Suspense>
      </section>
    </SiteShell>
  );
}
