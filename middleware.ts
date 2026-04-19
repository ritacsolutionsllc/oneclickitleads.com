import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/utils/supabase/middleware';

export async function middleware(request: NextRequest) {
  try {
    return await updateSession(request);
  } catch (err) {
    // Never let middleware crash a public page. Log and pass through.
    console.error('[middleware] updateSession threw:', err);
    return NextResponse.next({ request });
  }
}

export const config = {
  matcher: [
    // Match everything except Next internals and static assets. The auth
    // cookie must be refreshed before any SSR render of `/dashboard/**` or
    // API route hits `supabase.auth.getUser()`.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
