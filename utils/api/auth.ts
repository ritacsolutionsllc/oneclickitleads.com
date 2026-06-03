import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { planByTier } from '@/lib/plans';

export type ApiClientContext = {
  keyId: string;
  clientId: string;
  clientSlug: string;
  ownerUser: string | null;
  plan: string;
};

export type ApiAuthResult =
  | { ok: true; ctx: ApiClientContext }
  | { ok: false; status: number; error: string };

/**
 * Authenticates owner-created API keys.
 * Supported headers:
 *   Authorization: Bearer ocl_live_...
 *   x-api-key: ocl_live_...
 *
 * API keys are stored SHA-256 hashed in public.api_keys.
 * Only Growth, Agency, and Enterprise plans have API access.
 */
export async function authenticateApiKey(req: NextRequest): Promise<ApiAuthResult> {
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const rawKey = bearer || req.headers.get('x-api-key')?.trim() || '';

  if (!rawKey) return { ok: false, status: 401, error: 'missing api key' };
  if (!rawKey.startsWith('ocl_live_')) return { ok: false, status: 401, error: 'invalid api key format' };

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const admin = createAdminClient();

  const { data: keyRow, error } = await admin
    .from('api_keys')
    .select('id, client_id, revoked_at')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: error.message };
  if (!keyRow) return { ok: false, status: 401, error: 'invalid or revoked api key' };

  const { data: client, error: clientErr } = await admin
    .from('clients')
    .select('id, slug, owner_user, plan')
    .eq('id', keyRow.client_id)
    .maybeSingle();

  if (clientErr) return { ok: false, status: 500, error: clientErr.message };
  if (!client) return { ok: false, status: 404, error: 'api key client not found' };

  if (!planByTier(client.plan).features.apiAccess) {
    return { ok: false, status: 402, error: 'api access requires Growth, Agency, or Enterprise plan' };
  }

  try {
    await admin
      .from('api_keys')
      .update({ last_used: new Date().toISOString() })
      .eq('id', keyRow.id);
  } catch {
    // Non-fatal: auth should not fail just because usage telemetry failed.
  }

  return {
    ok: true,
    ctx: {
      keyId: keyRow.id,
      clientId: client.id,
      clientSlug: client.slug,
      ownerUser: client.owner_user,
      plan: client.plan,
    },
  };
}
