import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * GET /auth/callback?code=...&next=/dashboard/...
 * GET /auth/callback?token_hash=...&type=email&next=/dashboard/...
 *
 * Magic-link landing route. Supports two Supabase email auth flows:
 *
 *   1. PKCE (code): exchanges a one-time code via exchangeCodeForSession().
 *      Scanner-safe: the exchange requires the code_verifier cookie that only
 *      the originating browser session holds — scanners lack it.
 *
 *   2. OTP (token_hash + type): redirects to /auth/confirm so the user must
 *      click a button before verifyOtp() is called. This prevents email
 *      scanners/prefetchers from silently consuming the one-time token.
 *
 * Any failure routes back to /login with a readable ?error= rather than
 * crashing the request.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const token_hash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const rawNext = url.searchParams.get('next');
  const next = safeNext(rawNext);

  // PKCE flow — scanner-safe because code_verifier is in browser cookies.
  if (code) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        return NextResponse.redirect(
          new URL(`/login?error=${encodeURIComponent(error.message)}`, url),
        );
      }
    } catch (err) {
      console.error('[auth/callback] PKCE exchange failed:', err);
      return NextResponse.redirect(new URL('/login?error=auth_unavailable', url));
    }
    return NextResponse.redirect(new URL(next, url));
  }

  // OTP flow — redirect to confirm page; token is NOT consumed here.
  // The confirm page requires an explicit user click (POST) before
  // verifyOtp() is called, which defeats scanner prefetching.
  if (token_hash && type) {
    const confirmUrl = new URL('/auth/confirm', url);
    confirmUrl.searchParams.set('token_hash', token_hash);
    confirmUrl.searchParams.set('type', type);
    if (next !== '/dashboard') confirmUrl.searchParams.set('next', next);
    return NextResponse.redirect(confirmUrl);
  }

  return NextResponse.redirect(new URL('/login?error=missing_code', url));
}

/**
 * Only allow same-origin paths starting with a single `/`. Reject `//evil.com`,
 * `https://...`, and `javascript:` schemes. Falls back to /dashboard.
 */
function safeNext(next: string | null): string {
  if (!next) return '/dashboard';
  if (!next.startsWith('/')) return '/dashboard';
  if (next.startsWith('//')) return '/dashboard';
  if (next.startsWith('/\\')) return '/dashboard';
  return next;
}
