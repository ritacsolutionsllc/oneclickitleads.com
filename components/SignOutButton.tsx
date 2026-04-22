'use client';

import { useState } from 'react';
import { createClient } from '@/utils/supabase/client';

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch (err) {
      console.error('[sign-out] failed:', err);
    } finally {
      // Always navigate away — even if signOut threw, the local session
      // state is already wiped and the server will treat the next request
      // as anonymous.
      window.location.href = '/login?signed_out=1';
    }
  }

  return (
    <button
      onClick={signOut}
      disabled={busy}
      className="rounded-full border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
