import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';

/**
 * POST /api/push/smartly
 *   body: {
 *     client_slug: string,
 *     audience_name?: string,
 *     audience_id?: string,       // update an existing smartly Custom Audience
 *     segment?: string,           // icp_segment filter: 'b2c_beauty' | 'salon' | 'influencer' | 'retailer'
 *     min_score?: number          // default 60 (MX-valid minimum)
 *   }
 *
 * Flow:
 *   1. Pull scrubbed leads from Supabase for this client, filtered by ICP + score.
 *   2. SHA-256 hash emails + E.164 phones (Custom Audience requirement).
 *   3. POST to smartly.io Custom Audience API.
 *   4. Record row in `exports` for reconciliation + billing.
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
  } = await req.json();

  const token   = process.env.SMARTLY_API_TOKEN;
  const account = process.env.SMARTLY_ACCOUNT_ID;
  if (!token || !account)
    return NextResponse.json({ error: 'SMARTLY_API_TOKEN / SMARTLY_ACCOUNT_ID missing' }, { status: 500 });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', client_slug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  // Build the query — only export-eligible rows leave via smartly.
  let q = supabase
    .from('leads')
    .select('id, email, phone_e164, first_name, last_name, city, region, country, quality_score')
    .eq('client_id', client.id)
    .eq('export_eligibility', 'eligible')
    .gte('quality_score', min_score);
  if (segment) q = q.eq('icp_segment', segment);

  const { data: leads, error: qErr } = await q;
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  if (!leads?.length)
    return NextResponse.json({ error: 'no leads match filters', filters: { segment, min_score } }, { status: 400 });

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
    filters: { segment, min_score, audience_name, audience_id: returnedId },
    row_count: users.length,
  });

  // Flip exported rows out of 'eligible' so we don't re-push the same audience.
  await supabase
    .from('leads')
    .update({ export_eligibility: 'exported' })
    .in('id', leads.map((l) => l.id));

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
