import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * POST /api/auth/magic-link
 *
 * Server-side magic-link sender. Lives behind the client form at /login so
 * we can apply rate limiting before hitting Supabase's (per-project) quota.
 *
 * Input  : { email: string, redirectTo: string }
 * Output : { ok: true } | { error: string } (status 400 / 429 / 500)
 *
 * Rate limits (in-memory, per serverless instance — upgrade to Redis/Upstash
 * once traffic warrants):
 *   - per-email: 3 sends / 10 min    → prevents inbox spraying a specific user
 *   - per-ip:    10 sends / 60 min   → prevents a bot iterating through emails
 *
 * The Supabase anon key is used here (NOT service role). signInWithOtp is
 * designed to be called anonymously; routing through the server just buys
 * us a rate-limit chokepoint and consistent error shape.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Window = { hits: number[] };
const emailWindow = new Map<string, Window>();
const ipWindow = new Map<string, Window>();

const EMAIL_MAX = 3;
const EMAIL_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX = 10;
const IP_WINDOW_MS = 60 * 60 * 1000;

function hit(map: Map<string, Window>, key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = map.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= max) {
    map.set(key, bucket);
    return false;
  }
  bucket.hits.push(now);
  map.set(key, bucket);
  return true;
}

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

function isSameOriginPath(path: string, origin: string): boolean {
  try {
    const u = new URL(path, origin);
    return u.origin === origin && !path.startsWith('//');
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'auth service is not configured' }, { status: 500 });
  }

  let body: { email?: unknown; redirectTo?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'enter a valid email address' }, { status: 400 });
  }

  const origin = new URL(req.url).origin;
  const redirectTo =
    typeof body.redirectTo === 'string' && isSameOriginPath(body.redirectTo, origin)
      ? new URL(body.redirectTo, origin).toString()
      : `${origin}/auth/callback`;

  const ip = clientIp(req);
  if (!hit(ipWindow, ip, IP_MAX, IP_WINDOW_MS)) {
    return NextResponse.json(
      { error: 'too many requests from this network — try again later' },
      { status: 429 }
    );
  }
  if (!hit(emailWindow, email, EMAIL_MAX, EMAIL_WINDOW_MS)) {
    return NextResponse.json(
      { error: 'too many sign-in links sent to this email — try again in a few minutes' },
      { status: 429 }
    );
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: { getAll: () => [], setAll: () => {} },
  });

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });

  if (error) {
    console.error('[api/auth/magic-link] supabase error:', error.message);
    // Don't leak internal error shape to the client — a generic message
    // keeps enumeration attacks (user-exists vs user-doesn't) harder.
    return NextResponse.json(
      { error: 'we could not send the link — please try again' },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
