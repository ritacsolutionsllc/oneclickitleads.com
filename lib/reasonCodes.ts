/**
 * Human-readable labels + severity for the machine-readable reason codes
 * emitted by utils/scoring/quality.ts. The dashboard reads this to render
 * chips that explain *why* a lead landed in eligible / review / quarantine.
 */

export type ReasonSeverity = 'good' | 'info' | 'warn' | 'bad';

export interface ReasonMeta {
  label: string;
  severity: ReasonSeverity;
}

const REASONS: Record<string, ReasonMeta> = {
  // Identity
  ID_FIRST_PARTY:     { label: 'First-party',       severity: 'good' },
  ID_SMTP_VERIFIED:   { label: 'SMTP verified',     severity: 'good' },
  ID_MX_VALID:        { label: 'MX valid',          severity: 'info' },
  ID_SYNTAX_ONLY:     { label: 'Syntax only',       severity: 'warn' },
  ID_UNVERIFIED:      { label: 'Unverified',        severity: 'warn' },
  ID_DISPOSABLE:      { label: 'Disposable',        severity: 'bad'  },
  ID_BAD_SYNTAX:      { label: 'Bad syntax',        severity: 'bad'  },
  ID_NO_CONTACT:      { label: 'No contact',        severity: 'bad'  },

  // Completeness
  COMPLETENESS_OK:    { label: 'Complete profile',  severity: 'good' },
  COMPLETENESS_LOW:   { label: 'Sparse profile',    severity: 'warn' },

  // Source tier
  SOURCE_TIER_A:      { label: 'Tier A — 1st-party', severity: 'good' },
  SOURCE_TIER_B:      { label: 'Tier B — paid API',  severity: 'info' },
  SOURCE_TIER_C:      { label: 'Tier C — directory', severity: 'info' },
  SOURCE_TIER_D:      { label: 'Tier D — scraped',   severity: 'warn' },

  // ICP fit
  ICP_MATCH:          { label: 'ICP match',         severity: 'good' },
  ICP_TAG_SIGNAL:     { label: 'ICP tag signal',    severity: 'good' },
  ICP_UNKNOWN:        { label: 'No ICP',            severity: 'warn' },

  // Freshness
  FRESH_NEW:          { label: 'Fresh',             severity: 'good' },
  FRESH_7D:           { label: 'Fresh ≤7d',         severity: 'good' },
  FRESH_30D:          { label: 'Fresh ≤30d',        severity: 'good' },
  FRESH_90D:          { label: 'Fresh ≤90d',        severity: 'info' },
  FRESH_180D:         { label: 'Aging ≤180d',       severity: 'warn' },
  STALE:              { label: 'Stale >180d',       severity: 'warn' },

  // Intent
  INTENT_SIGNAL:      { label: 'Intent signal',     severity: 'good' },

  // Eligibility verdicts
  ELIGIBLE:               { label: 'Eligible',          severity: 'good' },
  REVIEW_LOW_SCORE:       { label: 'Low score',         severity: 'warn' },
  REVIEW_SCRAPED_UNVERIFIED: { label: 'Scrape unverified', severity: 'warn' },
  REVIEW_STALE:           { label: 'Needs re-verify',   severity: 'warn' },
  REVIEW_IDENTITY_WEAK:   { label: 'Identity weak',     severity: 'warn' },
  QUARANTINE_LOW_SCORE:   { label: 'Score too low',     severity: 'bad'  },
  QUARANTINE_DUPLICATE:   { label: 'Duplicate',         severity: 'bad'  },
  QUARANTINE_NO_CONTACT:  { label: 'No contact',        severity: 'bad'  },
  REJECT_SUPPRESSED:      { label: 'Suppressed',        severity: 'bad'  },
  REJECT_DISPOSABLE:      { label: 'Disposable',        severity: 'bad'  },
  REJECT_BAD_SYNTAX:      { label: 'Bad syntax',        severity: 'bad'  },
  REJECT_DUPLICATE:       { label: 'Duplicate',         severity: 'bad'  },
  REJECT_SUPPRESSED_HARD: { label: 'Hard suppressed',   severity: 'bad'  },
};

export function reasonMeta(code: string): ReasonMeta {
  if (REASONS[code]) return REASONS[code];
  // Generic fallback: turn SOURCE_TIER_X / REJECT_FOO into "Source tier X"
  const label = code
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
  const severity: ReasonSeverity = code.startsWith('REJECT_')
    ? 'bad'
    : code.startsWith('QUARANTINE_')
    ? 'bad'
    : code.startsWith('REVIEW_')
    ? 'warn'
    : 'info';
  return { label, severity };
}

export const ELIGIBILITY_LABEL: Record<string, string> = {
  eligible: 'Eligible',
  review: 'In review',
  quarantine: 'Quarantine',
  rejected: 'Rejected',
};

export const VERIFICATION_LABEL: Record<string, string> = {
  unverified: 'Unverified',
  syntax_valid: 'Syntax only',
  mx_valid: 'MX valid',
  smtp_verified: 'SMTP verified',
  first_party: 'First-party',
};
