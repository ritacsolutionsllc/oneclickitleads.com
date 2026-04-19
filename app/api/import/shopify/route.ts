import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import Papa from 'papaparse';
import { normalizeEmail } from '@/utils/scrub/email';
import { normalizePhone } from '@/utils/scrub/phone';
import { scoreLead, sourceTierFromKind } from '@/utils/quality/score';

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
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file');
  const clientSlug = String(form.get('client_slug') ?? '');
  const mode = String(form.get('mode') ?? 'both') as 'suppression' | 'seed' | 'both';

  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });
  if (!clientSlug)             return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length)
    return NextResponse.json({ error: 'CSV parse', details: parsed.errors.slice(0, 3) }, { status: 400 });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', clientSlug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const sourceTier = sourceTierFromKind('firstparty');
  const { data: src } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: 'firstparty',
      tier: sourceTier,
      label: `shopify import ${file.name} (${mode})`,
      source_url: 'shopify:customers.csv',
    })
    .select('id').single();

  const rows = parsed.data.filter((r) => r['Email']);

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
    const quality = scoreLead({
      email,
      phone_e164,
      first_name,
      last_name,
      icp_segment: 'b2c_beauty',
      syntax_valid: true,
      mx_valid: true,
      // Real purchase data: treat as verified.
      smtp_valid: true,
      is_disposable: false,
      is_duplicate: false,
      is_suppressed: false,
      source_tier: sourceTier,
      verified_at: new Date(),
    });
    return {
      client_id: client.id,
      source_id: src?.id,
      first_name,
      last_name,
      email,
      phone_e164,
      city: r['City'] || null,
      region: r['Province'] || null,
      country: r['Country'] || null,
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
      quality_score: quality.quality_score,
      verification_status: quality.verification_status,
      source_tier: sourceTier,
      export_eligibility: quality.export_eligibility,
      reason_codes: quality.reason_codes,
      verified_at: now,
      raw: r,
      scrubbed_at: now,
    };
  });

  let suppressed = 0;
  let seeded = 0;

  if (mode === 'suppression' || mode === 'both') {
    const { error } = await supabase.from('suppressions').insert(suppressionRows);
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
