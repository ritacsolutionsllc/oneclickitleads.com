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
    // Match everything except Next internals, static assets, and the Stripe
    // webhook. The webhook validates a raw-body HMAC signature; if the auth
    // middleware refreshes session cookies on that response, future hardening
    // could end up reading the body and break signature verification. Easier
    // to never let auth touch it.
    '/((?!_next/static|_next/image|favicon.ico|api/stripe/webhook|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
