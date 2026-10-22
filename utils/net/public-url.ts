import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Rejects URLs that would make the server fetch a private, loopback,
 * link-local, or metadata address. Callers must re-check after DNS
 * resolution and on every redirect.
 */

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.internal',
]);

export type AddressLookup = (hostname: string) => Promise<string[]>;

export function isNonPublicAddress(address: string): boolean {
  const raw = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw) return true;

  if (raw.startsWith('::ffff:')) {
    const v4 = raw.slice('::ffff:'.length);
    if (isIP(v4) === 4) return isNonPublicV4(v4);
  }

  const kind = isIP(raw);
  if (kind === 4) return isNonPublicV4(raw);
  if (kind === 6) return isNonPublicV6(raw);
  return true;
}

export function publicHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (BLOCKED_HOSTS.has(host)) return null;
  if (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.localdomain') ||
    host.endsWith('.internal')
  ) {
    return null;
  }

  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    return isNonPublicAddress(bare) ? null : url;
  }
  if (!host.includes('.') || /^\d+$/.test(host)) return null;
  return url;
}

export async function resolvePublicUrl(
  raw: string,
  lookupFn: AddressLookup = defaultLookup,
): Promise<URL | null> {
  const url = publicHttpUrl(raw);
  if (!url) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return url;
  let addresses: string[];
  try {
    addresses = await lookupFn(host);
  } catch {
    return null;
  }
  if (addresses.length === 0) return null;
  if (addresses.some((address) => isNonPublicAddress(address))) return null;
  return url;
}

export async function fetchPublicText(
  raw: string,
  opts?: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number },
): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const maxBytes = opts?.maxBytes ?? 500_000;
  const maxRedirects = opts?.maxRedirects ?? 3;
  let current = raw;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = await resolvePublicUrl(current);
    if (!target) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(target, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'OneClickitLeadsBot/1.0 (+https://oneclickitleads.com)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) return null;
        current = new URL(location, target).toString();
        continue;
      }
      if (!resp.ok) return null;
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('html') && !contentType.includes('text')) return null;
      return (await resp.text()).slice(0, maxBytes);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

function inCidr(ip: number, base: string, bits: number): boolean {
  const network = ipv4ToInt(base);
  if (network === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (network & mask);
}

function isNonPublicV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  return ranges.some(([base, bits]) => inCidr(value, base, bits));
}

function isNonPublicV6(ip: string): boolean {
  const bytes = expandIPv6(ip);
  if (!bytes) return true;
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes[15] === 1 && bytes.slice(0, 15).every((byte) => byte === 0)) return true;
  // IPv4-mapped ::ffff:0:0/96
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isNonPublicV4(v4);
  }
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  return false;
}

function expandIPv6(ip: string): number[] | null {
  let value = ip.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const v4 = ipv4ToInt(value.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    value = `${value.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    const word = parseInt(part, 16);
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes;
}
