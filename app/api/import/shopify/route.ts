import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createClient } from '@/utils/supabase/server';
import Papa from 'papaparse';
import { normalizeEmail } from '@/utils/scrub/email';
import { normalizePhone } from '@/utils/scrub/phone';
import { scoreLead } from '@/utils/scoring/score';
import { assignTier } from '@/utils/scoring/tier';

/**
 * POST /api/import/shopify
 *   multipart/form-data:
 *     file        — Shopify customers.csv export
 *     client_slug — tenant (e.g. "chella")
 *     mode        — "suppression" (don't re-acquire existing buyers, default)
 *                 | "seed"        (load as positive training signal for lookalikes)
 *                 | "both"        (do both in one pass — recommended on first run)
 *
 * Shopify export columns we care about:
 *   First Name, Last Name, Email, Phone, Accepts Email Marketing,
 *   Total Spent, Total Orders, Tags, City, Province, Country
 *
 * Why "suppression" mode matters: any dollar we spend on smartly.io acquiring
 * a lead Chella already owns is wasted. The suppressions table is joined on
 * export so these rows never leave the building.
 *
 * Auth:
 *   - logged-in owner of client_slug, OR
 *   - x-ingest-secret for trusted server-to-server jobs
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file');
  const clientSlug = String(form.get('client_slug') ?? '');
  const mode = String(form.get('mode') ?? 'both') as 'suppression' | 'seed' | 'both';

  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });
  if (!clientSlug)             return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  if (!['suppression', 'seed', 'both'].includes(mode)) {
    return NextResponse.json({ error: 'mode must be suppression, seed, or both' }, { status: 400 });
  }

  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'file too large; max 5MB' }, { status: 413 });
  }

  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length)
    return NextResponse.json({ error: 'CSV parse', details: parsed.errors.slice(0, 3) }, { status: 400 });

  if (parsed.data.length > 10_000) {
    return NextResponse.json({ error: 'too many rows; max 10,000 per import' }, { status: 413 });
  }

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id, owner_user').eq('slug', clientSlug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const ingestSecret = req.headers.get('x-ingest-secret');
  const trustedServerJob = Boolean(ingestSecret && ingestSecret === process.env.INGEST_SECRET);
  if (!trustedServerJob) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (client.owner_user !== user.id) return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const { data: src } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: 'firstparty',
      label: `shopify import ${file.name} (${mode})`,
      source_url: 'shopify:customers.csv',
      trust_tier: 1,
    })
    .select('id').single();

  const rows = parsed.data.filter((r) => r['Email'] && normalizeEmail(r['Email']));

  const suppressionRows = rows.map((r) => ({
    client_id: client.id,
    email: normalizeEmail(r['Email']),
    phone: r['Phone'] ? normalizePhone(r['Phone']) : null,
    reason: 'existing_customer',
  }));

  const now = new Date().toISOString();
  const seedRows = rows.map((r) => {
    const email = normalizeEmail(r['Email']);
    const phone_e164 = r['Phone'] ? normalizePhone(r['Phone']) : null;
    const first_name = r['First Name'] || null;
    const last_name = r['Last Name'] || null;
    const city = r['City'] || null;
    const region = r['Province'] || null;
    const country = r['Country'] || null;
    // Shopify customers are first-party (trust tier 1): real paying buyers.
    // Score directly rather than re-running the scrub pipeline (which would
    // waste NeverBounce credits on already-validated emails).
    const scores = scoreLead({
      syntax_valid: true,
      mx_valid: true,
      smtp_valid: true,
      is_disposable: false,
      is_duplicate: false,
      is_suppressed: false,
      email,
      phone_e164,
      first_name,
      last_name,
      city,
      region,
      country,
      icp_segment: 'b2c_beauty',
      source_trust_tier: 1,
      verified_at: null,
    });
    const export_tier = assignTier({
      composite_score: scores.composite_score,
      is_scrubbed: true,
    });
    return {
      client_id: client.id,
      source_id: src?.id,
      first_name,
      last_name,
      email,
      phone_e164,
      city,
      region,
      country,
      icp_segment: 'b2c_beauty',
      tags: [
        'shopify',
        'existing_customer',
        ...(Number(r['Total Orders'] ?? 0) >= 2 ? ['repeat_buyer'] : []),
        ...((r['Accepts Email Marketing'] ?? '').toLowerCase() === 'yes' ? ['opted_in'] : []),
      ],
      // Treat as scrubbed: it's first-party, already-validated purchase data.
      is_scrubbed: true,
      syntax_valid: true,
      mx_valid: true,
      smtp_valid: true,
      scrub_score: 100,
      identity_score: scores.identity_score,
      icp_fit_score: scores.icp_fit_score,
      completeness_score: scores.completeness_score,
      freshness_score: scores.freshness_score,
      intent_score: scores.intent_score,
      source_confidence: scores.source_confidence,
      export_tier,
      verified_at: now,
      verified_by: 'shopify-import',
      raw: r,
      scrubbed_at: now,
    };
  });

  let suppressed = 0;
  let seeded = 0;

  if (mode === 'suppression' || mode === 'both') {
    const { error } = await supabase
      .from('suppressions')
      .upsert(suppressionRows, { onConflict: 'client_id,email', ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    suppressed = suppressionRows.length;
  }

  if (mode === 'seed' || mode === 'both') {
    // conflict on (client_id, email_hash) → upsert so repeat imports are idempotent
    const { error } = await supabase
      .from('leads')
      .upsert(seedRows, { onConflict: 'client_id,email_hash', ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    seeded = seedRows.length;
  }

  return NextResponse.json({
    client: clientSlug,
    mode,
    rows_in_csv: rows.length,
    suppressions_added: suppressed,
    seed_leads_added: seeded,
  });
}
