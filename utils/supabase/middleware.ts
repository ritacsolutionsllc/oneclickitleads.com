import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

// Paths that require a signed-in user. Public marketing pages and the
// Supabase callback are deliberately excluded — they handle their own auth.
const PROTECTED_PREFIXES = ['/dashboard'];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Refreshes the Supabase auth session on every request and propagates any
 * rotated cookies back to the browser. Also gates `PROTECTED_PREFIXES`:
 * unauthenticated users are redirected to `/login?next=<original-path>` so
 * the magic-link callback can land them back where they started.
 *
 * Follows the official @supabase/ssr middleware pattern (getAll / setAll).
 */
export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    // Fail open for public routes — surfacing a 500 here would break the
    // whole site just because auth isn't configured yet. Downstream routes
    // that actually need auth will throw their own explicit errors.
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  let userId: string | null = null;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    // IMPORTANT: call getUser() — not getSession() — to force a token refresh
    // if the access token has expired. getSession() reads from cookies only.
    // Wrap in try/catch: if Supabase is unreachable or a cookie is corrupt,
    // we must NOT crash the request — public pages like /login have to render
    // even when the auth service is degraded.
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  } catch (err) {
    console.error('[supabase/middleware] getUser failed:', err);
  }

  // Auth gate: if this is a protected path and we have no user, bounce to
  // /login with the original destination as ?next= so the magic-link flow
  // can deep-link them back after sign-in.
  if (!userId && isProtectedPath(request.nextUrl.pathname)) {
    const loginUrl = new URL('/login', request.url);
    const dest = request.nextUrl.pathname + request.nextUrl.search;
    loginUrl.searchParams.set('next', dest);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}
