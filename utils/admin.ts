/**
 * Admin user bypass.
 *
 * Admins skip all plan-based export caps and billing gates.
 * Configure via ADMIN_EMAILS env var (comma-separated) in Vercel.
 *
 * Example: ADMIN_EMAILS=chris@chella.com,ritacsolutions@gmail.com
 */
function getAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? '';
  return new Set(
    raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().has(email.trim().toLowerCase());
}
