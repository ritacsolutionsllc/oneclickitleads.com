'use client';

import { createClient } from '@/utils/supabase/client';

export default function SignOutButton() {
  async function signOut() {
    const supabase = createClient();
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
