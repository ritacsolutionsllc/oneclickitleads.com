import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import Papa from 'papaparse';
import { normalizeEmail } from '@/utils/scrub/email';
import { normalizePhone } from '@/utils/scrub/phone';
import { scoreLead, sourceTierFor } from '@/utils/scoring/score';

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

  const { data: src } = await supabase
    .from('sources')
    .insert({
      client_id: client.id,
      kind: 'firstparty',
      tier: sourceTierFor('firstparty'),
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

  const seedRows = rows.map((r) => {
    const tags = [
      'shopify',
      'existing_customer',
      ...(Number(r['Total Orders'] ?? 0) >= 2 ? ['repeat_buyer'] : []),
      ...((r['Accepts Email Marketing'] ?? '').toLowerCase() === 'yes' ? ['opted_in'] : []),
    ];
    const base = {
      first_name: r['First Name'] || null,
      last_name: r['Last Name'] || null,
      email: normalizeEmail(r['Email']),
      phone_e164: r['Phone'] ? normalizePhone(r['Phone']) : null,
      city: r['City'] || null,
      region: r['Province'] || null,
      country: r['Country'] || null,
      icp_segment: 'b2c_beauty',
      tags,
      // Already-validated purchase data — treat the scrub flags as passing.
      syntax_valid: true,
      mx_valid: true,
      smtp_valid: true,
      is_disposable: false,
      is_duplicate: false,
      is_suppressed: false,
    };
    const scored = scoreLead({ ...base, source_kind: 'firstparty' });
    return {
      client_id: client.id,
      source_id: src?.id,
      ...base,
      // legacy scrub columns
      is_scrubbed: true,
      scrub_score: 100,
      // quality-first columns
      ...scored,
      verified_at: new Date().toISOString(),
      raw: r,
      scrubbed_at: new Date().toISOString(),
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
