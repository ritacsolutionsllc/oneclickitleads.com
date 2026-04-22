import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import SiteShell from '@/components/SiteShell';
import LoginForm from './LoginForm';

export const metadata: Metadata = {
  title: 'Sign in — OneClickitLeads',
  description:
    'Sign in to your OneClickitLeads client dashboard. We send a one-click magic link — no password to remember.',
  alternates: { canonical: 'https://oneclickitleads.com/login' },
  robots: { index: false, follow: false },
};

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
