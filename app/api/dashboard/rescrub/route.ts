import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import { scrubBatch, scoringInsertFields } from '@/utils/scrub/pipeline';

/**
 * POST /api/dashboard/rescrub
 *   body: { client_slug: string, limit?: number }
 *
 * Accepts two auth methods:
 *   1. Cookie-based Supabase session (browser / dashboard UI)
 *   2. x-ingest-secret header (forwarded from /api/dashboard/scrape proxy)
 *
 * Finds leads that have an email but haven't been fully scrubbed yet
 * (is_scrubbed IS NULL or false), runs them through the full scrub +
 * scoring pipeline, and updates their records in place.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const clientSlug = String(body.client_slug ?? '').slice(0, 64);
  const limit = Math.min(500, Math.max(1, Number(body.limit ?? 100)));

  if (!clientSlug) return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  const admin = createAdminClient();

  // Auth: accept ingest secret OR user session
  const ingestSecret = req.headers.get('x-ingest-secret');
  const useSecret = ingestSecret && ingestSecret === process.env.INGEST_SECRET;

  if (!useSecret) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    // Verify ownership via user-scoped client
    const { data: owned } = await supabase
      .from('clients')
      .select('id')
      .eq('slug', clientSlug)
      .eq('owner_user', user.id)
      .single();
    if (!owned) return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const { data: clientRow } = await admin
    .from('clients')
    .select('id, export_policy')
    .eq('slug', clientSlug)
    .single();
  if (!clientRow) return NextResponse.json({ error: 'client not found' }, { status: 404 });

  // Leads with an email that have not been scrubbed yet
  const { data: pending, error: fetchErr } = await admin
    .from('leads')
    .select('id, email, phone_e164, first_name, last_name, company, title, city, region, country, icp_segment, tags')
    .eq('client_id', clientRow.id)
    .not('email', 'is', null)
    .or('is_scrubbed.is.null,is_scrubbed.eq.false')
    .limit(limit);

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!pending?.length) return NextResponse.json({ processed: 0, clean: 0, message: 'No pending leads found' });

  const rawRows = pending.map((r: any) => ({
    email: r.email ?? undefined,
    phone: r.phone_e164 ?? undefined,
    first_name: r.first_name ?? undefined,
    last_name: r.last_name ?? undefined,
    company: r.company ?? undefined,
    title: r.title ?? undefined,
    city: r.city ?? undefined,
    region: r.region ?? undefined,
    country: r.country ?? undefined,
    icp_segment: r.icp_segment ?? undefined,
    tags: r.tags ?? undefined,
    _lead_id: r.id,
  }));

  const scrubbed = await scrubBatch(admin as never, clientRow.id, rawRows, {
    doEnrich: false,
    exportPolicy: clientRow.export_policy as never,
  });

  let clean = 0;
  const updates = scrubbed.map(async (s, i) => {
    const leadId = (rawRows[i] as { _lead_id: string })._lead_id;
    if (s.is_scrubbed) clean++;
    return admin.from('leads').update({
      is_scrubbed: s.is_scrubbed,
      is_duplicate: s.is_duplicate,
      syntax_valid: s.syntax_valid,
      mx_valid: s.mx_valid,
      smtp_valid: s.smtp_valid,
      is_disposable: s.is_disposable,
      scrub_score: s.scrub_score,
      reject_reason: s.reject_reason ?? null,
      scrubbed_at: new Date().toISOString(),
      ...scoringInsertFields(s),
    }).eq('id', leadId);
  });

  await Promise.all(updates);

  return NextResponse.json({
    processed: scrubbed.length,
    clean,
    rejected: scrubbed.length - clean,
  });
}
