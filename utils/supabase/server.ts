import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function createClient() {
  const cookieStore = await cookies();
  const url = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = requiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return createServerClient(url, key, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Server Components can't set cookies — middleware handles refresh.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {
          // Same as above.
        }
      },
    },
  });
}

// service-role client for trusted server tasks (never expose to browser)
export function createAdminClient() {
  const url = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createServerClient(url, key, {
    cookies: { get: () => undefined, set: () => {}, remove: () => {} },
  });
}
