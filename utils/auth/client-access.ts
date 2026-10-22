import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { canCustomScrape } from '@/lib/plans';
import { createAdminClient, createClient } from '@/utils/supabase/server';

export type ClientAccess = {
  ok: true;
  clientId: string;
  slug: string;
  plan: string | null;
  via: 'api_key' | 'session';
};

export type ClientAccessDenied = {
  ok: false;
  response: NextResponse;
};

/**
 * Authorize a request for one client.
 * A presented API key, ingest key, or bearer token must match an unrevoked
 * api_keys row for that client. A failed key does not fall through to the
 * session. The shared INGEST_SECRET is not accepted.
 * Session callers can be required to have a custom-scrape plan. Issued API
 * keys are not plan-gated.
 */
export async function requireClientAccess(
  req: Request,
  slug: string,
  opts?: { requireScrapePlan?: boolean },
): Promise<ClientAccess | ClientAccessDenied> {
  const cleanSlug = slug.trim().slice(0, 64);
  if (!cleanSlug) {
    return { ok: false, response: NextResponse.json({ error: 'client required' }, { status: 400 }) };
  }

  const presented = presentedCredential(req);
  const admin = createAdminClient();

  if (presented) {
    const keyHash = crypto.createHash('sha256').update(presented).digest('hex');
    const { data: keyRow } = await admin
      .from('api_keys')
      .select('id, client_id')
      .eq('key_hash', keyHash)
      .is('revoked_at', null)
      .maybeSingle();

    if (!keyRow) {
      return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
    }

    const { data: client } = await admin
      .from('clients')
      .select('id, slug, plan')
      .eq('id', keyRow.client_id)
      .maybeSingle();

    if (!client || client.slug !== cleanSlug) {
      return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
    }

    await admin
      .from('api_keys')
      .update({ last_used: new Date().toISOString() })
      .eq('id', keyRow.id);

    return {
      ok: true,
      clientId: client.id,
      slug: client.slug,
      plan: client.plan ?? null,
      via: 'api_key',
    };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, slug, plan')
    .eq('slug', cleanSlug)
    .eq('owner_user', user.id)
    .maybeSingle();

  if (!client) {
    return { ok: false, response: NextResponse.json({ error: 'client not found' }, { status: 404 }) };
  }

  if (opts?.requireScrapePlan && !canCustomScrape(client.plan)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Custom scraping requires the Agency plan.',
          upgrade_url: '/pricing',
          current_plan: client.plan,
        },
        { status: 402 },
      ),
    };
  }

  return {
    ok: true,
    clientId: client.id,
    slug: client.slug,
    plan: client.plan ?? null,
    via: 'session',
  };
}

function presentedCredential(req: Request): string | null {
  const headerValues = [req.headers.get('x-api-key'), req.headers.get('x-ingest-secret')];
  const authorization = req.headers.get('authorization');
  if (authorization && /^bearer\s+\S+/i.test(authorization)) {
    headerValues.push(authorization.replace(/^bearer\s+/i, ''));
  }
  for (const value of headerValues) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
