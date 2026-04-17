'use client';

import { createBrowserClient } from '@supabase/ssr';

export default function SignOutButton() {
  async function signOut() {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    await supabase.auth.signOut();
    window.location.href = '/';
  }

  return (
    <button
      onClick={signOut}
      className="rounded-full border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100"
    >
      Sign out
    </button>
  );
}
