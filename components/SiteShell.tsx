import Link from 'next/link';

export default function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-neutral-200">
        <div className="mx-auto max-w-6xl flex items-center justify-between px-6 py-4">
          <Link href="/" className="font-semibold tracking-tight text-lg">
            <span className="text-emerald-600">OneClick</span>itLeads
          </Link>
          <nav className="hidden md:flex gap-8 text-sm text-neutral-700">
            <Link href="/#how">How it works</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/contact">Contact</Link>
            <Link href="/dashboard" className="text-emerald-700 font-medium">
              Client login
            </Link>
          </nav>
        </div>
      </header>

      {children}

      <footer className="border-t border-neutral-200 bg-neutral-50">
        <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-neutral-500 flex flex-wrap justify-between gap-4">
          <span>© {new Date().getFullYear()} OneClickitLeads — a Ritac Solutions product.</span>
          <div className="flex gap-6">
            <Link href="/privacy">Privacy</Link>
            <Link href="/data-request">Data request</Link>
            <Link href="/contact">Contact</Link>
            <a href="mailto:contact@oneclickit.ai">contact@oneclickit.ai</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
