import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizePhone(raw: string, defaultCountry: 'US' | 'CA' | 'GB' = 'US'): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed?.isValid()) return null;
  return parsed.number; // E.164
}
