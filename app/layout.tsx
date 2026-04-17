import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'OneClickitLeads — Clean, scrubbed leads for performance marketing',
  description:
    'Gather, scrub, and export deliverable lead data into smartly.io, Klaviyo, or any ad platform. One click, done.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
