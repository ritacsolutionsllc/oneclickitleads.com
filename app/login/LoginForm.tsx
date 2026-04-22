'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const COOLDOWN_SECONDS = 30;
const LAST_EMAIL_KEY = 'oneclickit:last-login-email';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export default function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next');
  const initialError = searchParams.get('error');

  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(initialError);
  const [cooldown, setCooldown] = useState(0);

  // Prefill email from the previous successful send so a user who missed
  // the link doesn't have to retype it.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAST_EMAIL_KEY);
      if (saved) setEmail(saved);
    } catch {
      /* localStorage unavailable — no-op */
    }
  }, []);

  // Tick down the resend cooldown once per second.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === 'sending' || cooldown > 0) return;

    setStatus('sending');
    setErrorMsg(null);

    const redirectTo = next ? `/auth/callback?next=${encodeURIComponent(next)}` : '/auth/callback';

    try {
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, redirectTo }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? 'Something went wrong — please try again');
        setStatus('error');
        return;
      }

      try {
        localStorage.setItem(LAST_EMAIL_KEY, email);
      } catch {
        /* localStorage unavailable — no-op */
      }
      setStatus('sent');
      setCooldown(COOLDOWN_SECONDS);
    } catch {
      setErrorMsg('Network error — check your connection and try again');
      setStatus('error');
    }
  }

  const sendLabel = (() => {
    if (status === 'sending') return 'Sending link…';
    if (status === 'sent' && cooldown > 0) return `Resend in ${cooldown}s`;
    if (status === 'sent') return 'Resend link';
    return 'Send magic link';
  })();

  return (
    <form onSubmit={onSubmit} className="mt-8 grid gap-4" noValidate>
      <label className="grid gap-2">
        <span className="text-sm font-medium text-neutral-800">Work email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          autoFocus
          inputMode="email"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={status === 'error' || undefined}
          aria-describedby={status === 'error' ? 'login-error' : undefined}
          className="rounded-md border border-neutral-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </label>

      <button
        type="submit"
        disabled={status === 'sending' || cooldown > 0}
        className="rounded-md bg-emerald-600 px-5 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sendLabel}
      </button>

      {status === 'sent' && (
        <p className="text-sm text-emerald-700" role="status">
          Sent. Click the link in <strong>{email}</strong> to finish signing in. Don&apos;t see it?
          Check spam, then use the resend button above.
        </p>
      )}

      {status === 'error' && errorMsg && (
        <p id="login-error" className="text-sm text-red-600" role="alert">
          {errorMsg}
        </p>
      )}
    </form>
  );
}
