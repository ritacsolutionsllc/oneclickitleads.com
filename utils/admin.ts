const ADMIN_EMAILS = new Set([
  'ritacsolutions@gmail.com',
]);

export function isAdminEmail(email: string | null | undefined): boolean {
  return email ? ADMIN_EMAILS.has(email.toLowerCase()) : false;
}
