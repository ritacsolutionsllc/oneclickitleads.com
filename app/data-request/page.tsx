'use client';

import { useState } from 'react';
import SiteShell from '@/components/SiteShell';

type DsarType = 'access' | 'delete' | 'correct' | 'optout';

const TYPES: Array<{ value: DsarType; label: string; hint: string }> = [
  { value: 'access', label: 'Access my data', hint: 'Get a copy of everything we hold on you.' },
  { value: 'delete', label: 'Delete my data', hint: 'Erase your records (subject to legal retention).' },
  { value: 'correct', label: 'Correct my data', hint: 'Fix inaccurate personal details.' },
  { value: 'optout', label: 'Opt me out', hint: 'Add me to the suppression list going forward.' },
];

export default function DataRequestPage() {
  const [dsarType, setDsarType] = useState<DsarType>('access');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending');
    setErrorMsg(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      kind: 'dsar' as const,
      dsarType,
      name: String(fd.get('name') ?? ''),
      email: String(fd.get('email') ?? ''),
      message: String(fd.get('message') ?? ''),
      hp: String(fd.get('website') ?? ''),
    };
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setStatus('sent');
      (e.target as HTMLFormElement).reset();
    } else {
      const { error } = await res.json().catch(() => ({ error: 'send failed' }));
      setErrorMsg(error ?? 'send failed');
      setStatus('error');
    }
  }

  return (
    <SiteShell>
      <section className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-4xl font-semibold tracking-tight">Data request</h1>
        <p className="mt-3 text-neutral-600">
          Exercise your rights under CCPA/CPRA and GDPR. We respond within 45 days (CCPA)
          or 30 days (GDPR), whichever is shorter. Prefer email? Write to{' '}
          <a className="underline" href="mailto:contact@oneclickit.ai">
            contact@oneclickit.ai
          </a>
          .
        </p>

        <form onSubmit={onSubmit} className="mt-10 grid gap-6">
          <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />

          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium text-neutral-800">Request type</legend>
            {TYPES.map((t) => (
              <label
                key={t.value}
                className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer ${
                  dsarType === t.value ? 'border-emerald-600 bg-emerald-50' : 'border-neutral-300'
                }`}
              >
                <input
                  type="radio"
                  name="dsarType"
                  value={t.value}
                  checked={dsarType === t.value}
                  onChange={() => setDsarType(t.value)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium text-neutral-900 block">{t.label}</span>
                  <span className="text-sm text-neutral-600">{t.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-neutral-800">Your name</span>
            <input
              name="name"
              autoComplete="name"
              className="rounded-md border border-neutral-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <label className="grid gap-2">
            <span className="text-sm font-medium text-neutral-800">
              Email <span className="text-red-600">*</span>
            </span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="rounded-md border border-neutral-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <span className="text-xs text-neutral-500">
              Use the email address tied to the records you&apos;re asking about — this is
              how we verify identity.
            </span>
          </label>
          <label className="grid gap-2">
            <span className="text-sm font-medium text-neutral-800">
              Details <span className="text-red-600">*</span>
            </span>
            <textarea
              name="message"
              required
              rows={5}
              maxLength={5000}
              placeholder="Any additional context — e.g. which client's list you believe contains your data."
              className="rounded-md border border-neutral-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </label>

          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={status === 'sending'}
              className="rounded-md bg-emerald-600 px-5 py-2.5 text-white font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {status === 'sending' ? 'Submitting…' : 'Submit request'}
            </button>
            {status === 'sent' && (
              <span className="text-sm text-emerald-700">
                Received. You&apos;ll get a confirmation email shortly.
              </span>
            )}
            {status === 'error' && (
              <span className="text-sm text-red-600">Error: {errorMsg}</span>
            )}
          </div>
        </form>
      </section>
    </SiteShell>
  );
}
