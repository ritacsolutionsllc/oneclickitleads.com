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
 *     min_score?: number,         // composite_score floor (default 60). Always
 *                                 // upper-bounded by client.export_policy.min_composite_score.
 *     tier?: ExportTier           // optional: restrict to a single tier (must be 'allow' in policy)
 *   }
 *
 * Flow:
 *   1. Resolve the client's export_policy → which tiers are allowed to ship.
 *   2. Pull leads where export_tier ∈ allowed and composite_score >= floor.
 *   3. SHA-256 hash emails + E.164 phones (Custom Audience requirement).
 *   4. POST to smartly.io Custom Audience API.
 *   5. Record row in `exports` for reconciliation + billing.
 *
 * smartly.io API:
 *   Base: https://api.smartly.io/api/v3
 *   Auth: Authorization: Bearer <token>
 *
 * NOTE: smartly.io's Custom Audience endpoint path and request shape can vary
 * by account setup (Meta vs TikTok vs Snapchat destinations). The shape below
 * matches smartly's standard audience-sync pattern. Confirm once we have
 * Chella's token + destination in hand; if Chella's setup uses a different
 * path (e.g., going direct to Meta CAPI through smartly's proxy), the only
 * thing that changes is `SMARTLY_AUDIENCE_PATH`.
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
    min_score = 60,
    tier: tierFilter,
  } = await req.json();

  const token   = process.env.SMARTLY_API_TOKEN;
  const account = process.env.SMARTLY_ACCOUNT_ID;
  if (!token || !account)
    return NextResponse.json({ error: 'SMARTLY_API_TOKEN / SMARTLY_ACCOUNT_ID missing' }, { status: 500 });

  if (tierFilter && !VALID_TIERS.includes(tierFilter as ExportTier)) {
    return NextResponse.json(
      { error: `tier must be one of ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id, export_policy').eq('slug', client_slug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const policy = (client.export_policy ?? null) as ExportPolicy | null;
  const autoAllowed = allowedTiers(policy);
  const tiersToPush: ExportTier[] =
    tierFilter && autoAllowed.includes(tierFilter as ExportTier)
      ? [tierFilter as ExportTier]
      : autoAllowed;
  if (tiersToPush.length === 0)
    return NextResponse.json(
      { error: 'No tiers are enabled for export on this account.' },
      { status: 400 }
    );

  // Composite floor: max of caller's min_score and the policy's hard floor.
  const floor = Math.max(
    Number(min_score) || 0,
    Number(policy?.min_composite_score ?? 0)
  );

  // Build the query — composite_score / export_tier replace the legacy
  // scrub_score gate so quality and policy rule the destination, not the
  // raw email-validation score.
  let q = supabase
    .from('leads')
    .select('email, phone_e164, first_name, last_name, city, region, country, composite_score, export_tier')
    .eq('client_id', client.id)
    .eq('is_scrubbed', true)
    .in('export_tier', tiersToPush);
  if (floor > 0) q = q.gte('composite_score', floor);
  if (segment) q = q.eq('icp_segment', segment);

  const { data: leads, error: qErr } = await q;
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  if (!leads?.length)
    return NextResponse.json(
      { error: 'no leads match filters', filters: { segment, min_score: floor, tiers: tiersToPush } },
      { status: 400 }
    );

  // Hash for Custom Audience upload
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

  // POST to smartly
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

  // Both shapes are POSTs: create audience = POST /custom_audiences;
  // append to existing = POST /custom_audiences/:id/users.
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

  // Audit
  await supabase.from('exports').insert({
    client_id: client.id,
    destination: 'smartly',
    filters: {
      segment,
      min_composite_score: floor,
      tiers: tiersToPush,
      audience_name,
      audience_id: returnedId,
    },
    row_count: users.length,
  });

  return NextResponse.json({
    pushed: users.length,
    audience_id: returnedId,
    audience_name,
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
