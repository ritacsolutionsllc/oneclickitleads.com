import { promises as dns } from 'dns';

// RFC-5322 "good enough" regex — catches >99% of real-world typos
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Common disposable-email providers. Extend from https://github.com/disposable/disposable
const DISPOSABLE = new Set([
  'mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'throwaway.email',
  'sharklasers.com', 'maildrop.cc', 'dispostable.com',
]);

export function normalizeEmail(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim().toLowerCase();
  const [local, domain] = trimmed.split('@');
  if (!local || !domain) return trimmed;
  // strip +tag for gmail-style addresses (used for dedupe, not storage)
  const cleanedLocal = local.split('+')[0];
  return `${cleanedLocal}@${domain}`;
}

export function hasValidSyntax(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function isDisposable(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? DISPOSABLE.has(domain) : true;
}

export async function hasMxRecord(email: string): Promise<boolean> {
  const domain = email.split('@')[1];
  if (!domain) return false;
  try {
    const mx = await dns.resolveMx(domain);
    return mx.length > 0;
  } catch {
    return false;
  }
}

// SMTP verification. In production, call a paid provider for accuracy
// and to avoid your own IP getting greylisted.
export async function smtpVerify(email: string): Promise<{
  valid: boolean;
  provider: 'neverbounce' | 'zerobounce' | 'skip';
  raw?: unknown;
}> {
  const nb = process.env.NEVERBOUNCE_API_KEY;
  const zb = process.env.ZEROBOUNCE_API_KEY;

  if (nb) {
    const url = `https://api.neverbounce.com/v4/single/check?key=${nb}&email=${encodeURIComponent(email)}`;
    const r = await fetch(url);
    const data = (await r.json()) as { result?: string };
    return {
      valid: data.result === 'valid',
      provider: 'neverbounce',
      raw: data,
    };
  }

  if (zb) {
    const url = `https://api.zerobounce.net/v2/validate?api_key=${zb}&email=${encodeURIComponent(email)}`;
    const r = await fetch(url);
    const data = (await r.json()) as { status?: string };
    return {
      valid: data.status === 'valid',
      provider: 'zerobounce',
      raw: data,
    };
  }

  // No verifier configured — skip this stage in dev
  return { valid: true, provider: 'skip' };
}

export interface ScrubResult {
  email: string;
  normalized: string;
  syntax_valid: boolean;
  mx_valid: boolean;
  smtp_valid: boolean;
  is_disposable: boolean;
  score: number; // 0–100
  reject_reason?: string;
}

export async function scrubEmail(raw: string): Promise<ScrubResult> {
  const normalized = normalizeEmail(raw);
  const syntax = hasValidSyntax(normalized);
  if (!syntax) {
    return {
      email: raw, normalized,
      syntax_valid: false, mx_valid: false, smtp_valid: false,
      is_disposable: false, score: 0, reject_reason: 'bad_syntax',
    };
  }
  const disposable = isDisposable(normalized);
  if (disposable) {
    return {
      email: raw, normalized,
      syntax_valid: true, mx_valid: false, smtp_valid: false,
      is_disposable: true, score: 0, reject_reason: 'disposable_domain',
    };
  }
  const mx = await hasMxRecord(normalized);
  if (!mx) {
    return {
      email: raw, normalized,
      syntax_valid: true, mx_valid: false, smtp_valid: false,
      is_disposable: false, score: 20, reject_reason: 'no_mx',
    };
  }
  const { valid: smtp } = await smtpVerify(normalized);
  const score = smtp ? 100 : 60; // MX-valid but SMTP-unverified = "maybe"
  return {
    email: raw, normalized,
    syntax_valid: true, mx_valid: true, smtp_valid: smtp,
    is_disposable: false, score,
    reject_reason: smtp ? undefined : 'smtp_failed',
  };
}
