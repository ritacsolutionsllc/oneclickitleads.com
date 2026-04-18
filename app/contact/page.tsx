'use client';

import { useState } from 'react';
import SiteShell from '@/components/SiteShell';

export default function ContactPage() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending');
    setErrorMsg(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      kind: 'contact' as const,
      name: String(fd.get('name') ?? ''),
      email: String(fd.get('email') ?? ''),
      company: String(fd.get('company') ?? ''),
      subject: String(fd.get('subject') ?? ''),
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
      <section className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-4xl font-semibold tracking-tight">Contact us</h1>
        <p className="mt-3 text-neutral-600">
          Questions about the product, pricing, or enterprise plans? We reply within one
          business day. You can also email{' '}
          <a className="underline" href="mailto:contact@oneclickit.ai">
            contact@oneclickit.ai
          </a>{' '}
          directly.
        </p>

        <form onSubmit={onSubmit} className="mt-10 grid gap-5">
          <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />

          <div className="grid md:grid-cols-2 gap-5">
            <Field label="Your name" name="name" autoComplete="name" />
            <Field label="Email" name="email" type="email" required autoComplete="email" />
          </div>
          <Field label="Company (optional)" name="company" autoComplete="organization" />
          <Field label="Subject" name="subject" />
          <label className="grid gap-2">
            <span className="text-sm font-medium text-neutral-800">Message</span>
            <textarea
              name="message"
              required
              rows={6}
              maxLength={5000}
              className="rounded-md border border-neutral-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </label>

          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={status === 'sending'}
              className="rounded-md bg-emerald-600 px-5 py-2.5 text-white font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {status === 'sending' ? 'Sending…' : 'Send message'}
            </button>
            {status === 'sent' && (
              <span className="text-sm text-emerald-700">Thanks — we’ll be in touch.</span>
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

function Field({
  label,
  name,
  type = 'text',
  required,
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-medium text-neutral-800">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        className="rounded-md border border-neutral-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
    </label>
  );
}
