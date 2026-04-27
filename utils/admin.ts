export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const configured = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(email.trim().toLowerCase());
}
