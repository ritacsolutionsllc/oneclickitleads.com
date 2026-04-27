'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard',              label: 'Overview',    icon: '◎' },
  { href: '/dashboard/scrape',       label: 'Scrape',      icon: '⊕' },
  { href: '/dashboard/leads',        label: 'Leads',       icon: '◈' },
  { href: '/dashboard/quality',      label: 'Quality',     icon: '★' },
  { href: '/dashboard/suppressions', label: 'Suppressions', icon: '◇' },
  { href: '/dashboard/exports',      label: 'Exports',     icon: '↗' },
  { href: '/dashboard/billing',      label: 'Billing',     icon: '$' },
  { href: '/dashboard/settings',     label: 'Settings',    icon: '⚙' },
  { href: '/contact',                label: 'Support',     icon: '?' },
];

export default function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav className="md:sticky md:top-8 self-start">
      <ul className="space-y-1">
        {LINKS.map((l) => {
          const active = pathname === l.href || (l.href !== '/dashboard' && pathname.startsWith(l.href));
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-emerald-50 text-emerald-800 font-medium'
                    : 'text-neutral-700 hover:bg-neutral-100'
                }`}
              >
                <span className="text-neutral-400 w-4 text-center">{l.icon}</span>
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
