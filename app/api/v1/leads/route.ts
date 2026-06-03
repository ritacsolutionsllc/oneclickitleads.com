import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { authenticateApiKey } from '@/utils/api/auth';
import { scrubBatch, scoringInsertFields, type RawLead } from '@/utils/scrub/pipeline';

const MAX_ROWS_PER_REQUEST = 100;
const ALLOWED_SOURCE_KINDS = new Set(['firstparty', 'partner', 'licensed', 'manual', 'api']);
const ALLOWED_SEGMENTS = new Set(['salon', 'b2c_beauty', 'influencer', 'retailer']);

type Body = {
  source?: {
    kind?: string;
    label?: string;
    source_url?: string;
    permission_basis?: string;
  };
  rows?: RawLead[];
};

/**
 * POST /api/v1/leads
 * Owner/customer API for compliant lead ingestion only.
 *
 * This endpoint does NOT scrape, enrich from prohibited sources, or bypass source terms.
 * Callers must provide rows they are permitted to process and source metadata.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const rows = body.rows ?? [];
  const source = body.source ?? {};
  const sourceKind = String(source.kind ?? '').toLowerCase();

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'rows must be a non-empty array' }, { status: 400 });
  }
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return NextResponse.json(
      { error: `too many rows: ${rows.length}; max ${MAX_ROWS_PER_REQUEST} per request` },
      { status: 413 },
    );
  }
  if (!ALLOWED_SOURCE_KINDS.has(sourceKind)) {
    return NextResponse.json(
      { error: `source.kind must be one of: ${[...ALLOWED_SOURCE_KINDS].join(', ')}` },
      { status: 400 },
    );
  }
  if (!source.permission_basis || String(source.permission_basis).trim().length < 6) {
    return NextResponse.json(
      { error: 'source.permission_basis is required for compliance/audit trail' },
      { status: 400 },
    );
  }

  const normalizedRows: RawLead[] = rows.map((r) => ({
    ...r,
    email: typeof r.email === 'string' ? r.email.trim().toLowerCase() : undefined,
    phone: typeof r.phone === 'string' ? r.phone.trim() : undefined,
    first_name: typeof r.first_name === 'string' ? r.first_name.trim() : undefined,
    last_name: typeof r.last_name === 'string' ? r.last_name.trim() : undefined,
    company: typeof r.company === 'string' ? r.company.trim() : undefined,
    title: typeof r.title === 'string' ? r.title.trim() : undefined,
    city: typeof r.city === 'string' ? r.city.trim() : undefined,
    region: typeof r.region === 'string' ? r.region.trim() : undefined,
    country: typeof r.country === 'string' ? r.country.trim() : undefined,
    icp_segment: ALLOWED_SEGMENTS.has(String(r.icp_segment ?? '')) ? r.icp_segment : 'b2c_beauty',
    tags: Array.isArray(r.tags) ? r.tags.slice(0, 10).map(String) : ['api_ingest'],
  })).filter((r) => r.email || r.phone || r.company);

  if (!normalizedRows.length) {
    return NextResponse.json(
      { error: 'no usable rows: provide at least email, phone, or company per row' },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data: srcRow, error: srcErr } = await supabase
    .from('sources')
    .insert({
      client_id: auth.ctx.clientId,
      kind: sourceKind,
      label: source.label ?? `api:${auth.ctx.keyId.slice(0, 8)}`,
      source_url: source.source_url ?? null,
    })
    .select('id')
    .single();

  if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });

  const scrubbed = await scrubBatch(supabase as never, auth.ctx.clientId, normalizedRows, {
    doEnrich: false,
    sourceTrustTier: sourceKind === 'firstparty' ? 1 : sourceKind === 'licensed' ? 2 : 3,
  });

  const now = new Date().toISOString();
  const inserts = scrubbed.map((s) => ({
    client_id: auth.ctx.clientId,
    source_id: srcRow?.id,
    first_name: s.first_name ?? null,
    last_name: s.last_name ?? null,
    email: s.normalized_email || null,
    phone_e164: s.phone_e164,
    company: s.company ?? null,
    title: s.title ?? null,
    linkedin_url: (s as { linkedin_url?: string }).linkedin_url ?? null,
    city: s.city ?? null,
    region: s.region ?? null,
    country: s.country ?? null,
    icp_segment: s.icp_segment ?? 'b2c_beauty',
    tags: [...new Set([...(s.tags ?? []), 'api_ingest'])].slice(0, 12),
    is_scrubbed: s.is_scrubbed,
    syntax_valid: s.syntax_valid,
    mx_valid: s.mx_valid,
    smtp_valid: s.smtp_valid,
    is_disposable: s.is_disposable,
    is_duplicate: s.is_duplicate,
    is_suppressed: s.is_suppressed,
    scrub_score: s.scrub_score,
    reject_reason: s.reject_reason,
    ...scoringInsertFields(s),
    raw: {
      ...s,
      source_kind: sourceKind,
      permission_basis: source.permission_basis,
      api_key_id: auth.ctx.keyId,
    },
    scrubbed_at: now,
  }));

  const { error } = await supabase.from('leads').insert(inserts);
  if (error) {
    return NextResponse.json(
      {
        error: error.message,
        hint: 'If this is a duplicate email, treat the row as already present or update it through the dashboard.',
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    client: auth.ctx.clientSlug,
    received: rows.length,
    accepted: inserts.length,
    clean: inserts.filter((r) => r.is_scrubbed).length,
    rejected: inserts.filter((r) => !r.is_scrubbed).length,
    source_id: srcRow?.id,
  });
}
