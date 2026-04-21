import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { enforceExport } from '@/utils/plans/enforce';
import { allowedTiers, type ExportPolicy, type ExportTier } from '@/utils/scoring/tier';

/**
 * POST /api/push/smartly
 *   body: {
 *     client_slug: string,
 *     audience_name?: string,
 *     audience_id?: string,       // update an existing smartly Custom Audience
 *     segment?: string,           // icp_segment filter: 'b2c_beauty' | 'salon' | 'influencer' | 'retailer'
 *     tier?: ExportTier,          // one of the caller's policy-allowed tiers
 *     min_score?: number          // optional additional floor on composite_score
 *   }
 *
 * Quality-first gate (mirrors /api/export):
 *   - is_scrubbed must be true (RLS enforces tenant, this enforces verified).
 *   - export_tier must be in the client's policy-allowed tiers. `review`-tier
 *     leads only ship when the operator approves them (review_state='approved').
 *   - composite_score must be >= the higher of min_score and the client's
 *     policy floor.
 *   - plan enforcement via enforceExport (v_client_usage).
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
    tier: tierFilterRaw,
    min_score = 0,
  } = (await req.json()) as {
    client_slug?: string;
    audience_name?: string;
    audience_id?: string;
    segment?: string;
    tier?: string;
    min_score?: number;
  };

  if (!client_slug)
    return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  const tierFilter =
    tierFilterRaw && (VALID_TIERS as readonly string[]).includes(tierFilterRaw)
      ? (tierFilterRaw as ExportTier)
      : null;
  if (tierFilterRaw && !tierFilter) {
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
    .from('clients').select('id, export_policy').eq('slug', client_slug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  // Plan enforcement first — don't hash PII if the caller is over the cap.
  const cap = await enforceExport(client.id);
  if (!cap.ok) {
    return NextResponse.json(
      {
        error: 'Monthly plan cap reached',
        detail: `Used ${cap.used} / ${cap.cap} clean leads on the ${cap.plan} plan this month.`,
      },
      { status: 402 }
    );
  }

  const policy = (client.export_policy ?? null) as ExportPolicy | null;
  const autoAllowed = allowedTiers(policy);
  const tiersToExport: ExportTier[] = tierFilter
    ? autoAllowed.includes(tierFilter)
      ? [tierFilter]
      : []
    : autoAllowed;

  if (tiersToExport.length === 0) {
    return NextResponse.json(
      { error: 'No tiers enabled for export on this account.' },
      { status: 400 }
    );
  }

  const floor = Math.max(Number(min_score) || 0, Number(policy?.min_composite_score ?? 0));

  // Build the query: gate on tier + score, then peel off review-tier rows
  // that haven't been explicitly approved by an operator.
  let q = supabase
    .from('leads')
    .select('email, phone_e164, first_name, last_name, city, region, country, composite_score, export_tier, review_state')
    .eq('client_id', client.id)
    .eq('is_scrubbed', true)
    .in('export_tier', tiersToExport)
    .limit(Math.min(cap.remaining ?? 10_000, 50_000));
  if (segment) q = q.eq('icp_segment', segment);
  if (floor > 0) q = q.gte('composite_score', floor);

  const { data: leadsRaw, error: qErr } = await q;
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });

  // Review-tier leads only escape if operator-approved. Rejected/pending
  // never ship regardless of tier, even if the policy allows `review`.
  const leads = (leadsRaw ?? []).filter((l) => {
    if (l.export_tier === 'review') return l.review_state === 'approved';
    return l.review_state !== 'rejected';
  });

  if (!leads.length) {
    return NextResponse.json(
      {
        error: 'no leads match filters',
        filters: { segment, tiers: tiersToExport, min_score: floor || undefined },
      },
      { status: 400 }
    );
  }

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
      tiers: tiersToExport,
      min_composite_score: floor || undefined,
      audience_name,
      audience_id: returnedId,
    },
    row_count: users.length,
  });

  return NextResponse.json({
    pushed: users.length,
    audience_id: returnedId,
    audience_name,
    tiers: tiersToExport,
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
