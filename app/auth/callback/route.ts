import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * GET /auth/callback?code=...&next=/dashboard/...
 * GET /auth/callback?token_hash=...&type=email&next=/dashboard/...
 *
 * Magic-link landing route. Supports two Supabase email auth flows:
 *   1. PKCE (code): exchanges a one-time code via exchangeCodeForSession()
 *   2. OTP (token_hash + type): verifies the token via verifyOtp()
 *
 * Both flows store the session in cookies and redirect to `next` (validated
 * to be a same-origin path — never an absolute URL — to prevent open-redirect
 * phishing). Any failure routes back to /login with a readable ?error= rather
 * than crashing the request.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const token_hash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const rawNext = url.searchParams.get('next');
  const next = safeNext(rawNext);

  try {
    const supabase = await createClient();

    if (code) {
      // PKCE flow — code exchanged for a session server-side
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        return NextResponse.redirect(
          new URL(`/login?error=${encodeURIComponent(error.message)}`, url),
        );
      }
    } else if (token_hash && type) {
      // OTP flow — newer Supabase email templates use token_hash + type=email
      const { error } = await supabase.auth.verifyOtp({ token_hash, type });
      if (error) {
        return NextResponse.redirect(
          new URL(`/login?error=${encodeURIComponent(error.message)}`, url),
        );
      }
    } else {
      return NextResponse.redirect(new URL('/login?error=missing_code', url));
    }
  } catch (err) {
    console.error('[auth/callback] exchange failed:', err);
    return NextResponse.redirect(new URL('/login?error=auth_unavailable', url));
  }

  return NextResponse.redirect(new URL(next, url));
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
