import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * POST /api/auth/confirm
 *
 * Body: { token_hash: string; type: string; next?: string }
 *
 * Called by /auth/confirm after the user explicitly clicks "Sign in".
 * Verifies the OTP token and sets the Supabase session cookie.
 * Returns { next } on success or { error } on failure.
 *
 * POST-only keeps scanner prefetchers (GET) from triggering the exchange.
 */
export async function POST(req: Request) {
  let body: { token_hash?: string; type?: string; next?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { token_hash, type, next: rawNext } = body;
  const next = safeNext(rawNext);

  if (!token_hash || !type) {
    return NextResponse.json({ error: 'Missing token_hash or type' }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      token_hash,
      type: type as EmailOtpType,
    });
    if (error) {
      const msg =
        error.message === 'Token has expired or is invalid'
          ? 'This link has expired or has already been used. Please request a new one.'
          : error.message;
      return NextResponse.json({ error: msg }, { status: 401 });
    }
    return NextResponse.json({ next });
  } catch (err) {
    console.error('[api/auth/confirm] verifyOtp failed:', err);
    return NextResponse.json(
      { error: 'Authentication service unavailable. Please try again.' },
      { status: 503 },
    );
  }
}

function safeNext(next: string | null | undefined): string {
  if (!next) return '/dashboard';
  if (!next.startsWith('/')) return '/dashboard';
  if (next.startsWith('//')) return '/dashboard';
  if (next.startsWith('/\\')) return '/dashboard';
  return next;
}
