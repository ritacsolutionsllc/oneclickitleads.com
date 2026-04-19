import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Refreshes the Supabase auth session on every request and propagates any
 * rotated cookies back to the browser. Without this middleware, the session
 * cookie goes stale between SSR requests and `/dashboard` bounces authenticated
 * users back to `/login`.
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
  await supabase.auth.getUser();

  return response;
}
