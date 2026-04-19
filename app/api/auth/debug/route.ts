import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';

/**
 * GET /api/auth/debug
 *
 * Diagnostic endpoint for Supabase auth. Returns whether the current request
 * has a valid server-side session. Does NOT return access tokens, refresh
 * tokens, or cookie values — only cookie names, user id, email, and the
 * session expiry.
 *
 * Use to confirm the SSR middleware is refreshing cookies and the server
 * client can read the session. Safe to leave in production.
 */
export async function GET() {
  const cookieStore = await cookies();
  const cookieNames = cookieStore.getAll().map((c) => c.name);

  let user: { id: string; email: string | undefined } | null = null;
  let expiresAt: number | null = null;
  let error: string | null = null;

  try {
    const supabase = await createClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr) {
      error = userErr.message;
    } else if (userData.user) {
      user = { id: userData.user.id, email: userData.user.email ?? undefined };
    }
    // getSession is safe here: we only expose expires_at, not the token.
    const { data: sessionData } = await supabase.auth.getSession();
    expiresAt = sessionData.session?.expires_at ?? null;
  } catch (e) {
    error = (e as Error).message;
  }

  return NextResponse.json(
    {
      authenticated: !!user,
      user,
      session_expires_at: expiresAt,
      cookie_names: cookieNames,
      error,
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
