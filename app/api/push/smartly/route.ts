import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { allowedTiers, type ExportPolicy, type ExportTier } from '@/utils/scoring/tier';

/**
 * POST /api/push/smartly
 *   body: {
 *     client_slug: string,
 *     audience_name?: string,
 *     audience_id?: string,       // update an existing smartly Custom Audience
 *     segment?: string,           // icp_segment filter: 'b2c_beauty' | 'salon' | 'influencer' | 'retailer'
 *     tier?: ExportTier,          // optional: one of the tiers the policy allows
 *     min_score?: number          // optional composite_score floor, clamped to policy.min_composite_score
 *   }
 *
 * Flow:
 *   1. Enforce the client's export_policy: only ship leads whose export_tier
 *      is `allow`ed. `manual` and `block` tiers never reach smartly through
 *      this endpoint — the review queue handles `manual`.
 *   2. Apply min_composite_score floor (policy + caller, whichever is higher).
 *   3. Pull scrubbed leads, SHA-256 hash email/phone (Custom Audience req).
 *   4. POST to smartly.io Custom Audience API.
 *   5. Record row in `exports` for reconciliation + billing.
 *
 * smartly.io API:
 *   Base: https://api.smartly.io/api/v3
 *   Auth: Authorization: Bearer <token>
 */
const SMARTLY_BASE           = process.env.SMARTLY_API_BASE || 'https://api.smartly.io/api/v3';
const SMARTLY_AUDIENCE_PATH  = process.env.SMARTLY_AUDIENCE_PATH || '/custom_audiences';

const VALID_TIERS: ExportTier[] = [
  'premium',
  'standard',
  'prospecting',
  'review',
  'hold',
  'discard',
];

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const {
    client_slug,
    audience_name = `OneClickitLeads export ${new Date().toISOString().slice(0, 10)}`,
    audience_id,
    segment,
    tier: tierFilter,
    min_score,
  } = await req.json();

  if (tierFilter && !VALID_TIERS.includes(tierFilter as ExportTier)) {
    return NextResponse.json(
      { error: `tier must be one of ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    );
  }

  const token   = process.env.SMARTLY_API_TOKEN;
  const account = process.env.SMARTLY_ACCOUNT_ID;
  if (!token || !account)
    return NextResponse.json({ error: 'SMARTLY_API_TOKEN / SMARTLY_ACCOUNT_ID missing' }, { status: 500 });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients')
    .select('id, export_policy')
    .eq('slug', client_slug)
    .single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const policy = (client.export_policy ?? null) as ExportPolicy | null;
  const autoAllowed = allowedTiers(policy);

  // If the caller asked for a specific tier, only honor it if policy allows it.
  // Otherwise default to the full set of allow-listed tiers.
  const tiersToShip: ExportTier[] =
    tierFilter && autoAllowed.includes(tierFilter as ExportTier)
      ? [tierFilter as ExportTier]
      : autoAllowed;

  if (tiersToShip.length === 0) {
    return NextResponse.json(
      { error: 'No tiers are enabled for auto-push on this account.' },
      { status: 400 }
    );
  }

  const floor = Math.max(
    Number(min_score ?? 0),
    Number(policy?.min_composite_score ?? 0)
  );

  let q = supabase
    .from('leads')
    .select('email, phone_e164, first_name, last_name, city, region, country, composite_score, export_tier')
    .eq('client_id', client.id)
    .eq('is_scrubbed', true)
    .in('export_tier', tiersToShip);
  if (segment) q = q.eq('icp_segment', segment);
  if (floor > 0) q = q.gte('composite_score', floor);

  const { data: leads, error: qErr } = await q;
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  if (!leads?.length)
    return NextResponse.json(
      {
        error: 'no leads match filters',
        filters: { segment, min_composite_score: floor || undefined, tiers: tiersToShip },
      },
      { status: 400 }
    );

  const users = await Promise.all(
    leads.map(async (l) => ({
      email:  l.email      ? await sha256(l.email.trim().toLowerCase()) : undefined,
      phone:  l.phone_e164 ? await sha256(l.phone_e164.replace(/\D/g, '')) : undefined,
      first_name: l.first_name ? await sha256(l.first_name.trim().toLowerCase()) : undefined,
      last_name:  l.last_name  ? await sha256(l.last_name.trim().toLowerCase()) : undefined,
      city:   l.city   ? await sha256(l.city.trim().toLowerCase())   : undefined,
      region: l.region ? await sha256(l.region.trim().toLowerCase()) : undefined,
      country: l.country ?? 'US',
    }))
  );

  const url = audience_id
    ? `${SMARTLY_BASE}${SMARTLY_AUDIENCE_PATH}/${audience_id}/users`
    : `${SMARTLY_BASE}${SMARTLY_AUDIENCE_PATH}`;

  const payload = audience_id
    ? { account_id: account, users }
    : {
        account_id: account,
        name: audience_name,
        description: `Auto-synced from OneClickitLeads (${users.length} leads)`,
        subtype: 'CUSTOM',
        users,
      };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    return NextResponse.json(
      { error: `smartly: HTTP ${resp.status}`, detail: raw.slice(0, 1000) },
      { status: 502 }
    );
  }
  const smartlyResponse = safeJson(raw);
  const returnedId = (smartlyResponse as { id?: string; audience_id?: string })?.id
                  ?? (smartlyResponse as { id?: string; audience_id?: string })?.audience_id
                  ?? audience_id;

  await supabase.from('exports').insert({
    client_id: client.id,
    destination: 'smartly',
    filters: {
      segment,
      min_composite_score: floor || undefined,
      tiers: tiersToShip,
      audience_name,
      audience_id: returnedId,
    },
    row_count: users.length,
  });

  return NextResponse.json({
    pushed: users.length,
    audience_id: returnedId,
    audience_name,
    tiers: tiersToShip,
    min_composite_score: floor || undefined,
    smartly: smartlyResponse,
  });
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return s; }
}
