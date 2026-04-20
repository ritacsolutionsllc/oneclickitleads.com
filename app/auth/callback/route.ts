import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

/**
 * GET /auth/callback?code=...&next=/dashboard/...
 *
 * Magic-link landing route. Exchanges the one-time code for a session, then
 * redirects to `next` (validated to be a same-origin path — never an absolute
 * URL — to avoid open-redirect phishing). Any failure routes back to /login
 * with a readable ?error= rather than crashing the request.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const rawNext = url.searchParams.get('next');
  const next = safeNext(rawNext);

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url));
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent(error.message)}`, url),
      );
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
