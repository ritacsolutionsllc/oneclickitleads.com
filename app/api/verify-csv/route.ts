import { NextRequest, NextResponse } from 'next/server';
import Papa from 'papaparse';
import { createAdminClient, createClient } from '@/utils/supabase/server';
import { scrubBatch, type RawLead } from '@/utils/scrub/pipeline';
import { buildLeadRow } from '@/utils/leads/insert';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/verify-csv
 *   multipart/form-data:
 *     file         — CSV of raw leads (any reasonable header casing)
 *     client_slug  — tenant to ingest into
 *     source_label — optional human label for the sources row
 *     format       — "json" (default) | "csv" (streams cleaned CSV back)
 *
 * Runs every row through the canonical scrub pipeline (syntax, disposable,
 * MX, SMTP via NeverBounce/ZeroBounce, suppression + dedupe), then the
 * scoring engine, then inserts to public.leads. Verified leads are
 * immediately exportable via /api/export or pushable to Smartly.io /
 * downloadable as CSV to paste into Smartleads.ai.
 *
 * Column auto-detection: we look for headers containing "email", "phone",
 * "first"/"fname", "last"/"lname", "company"/"org", "title", "city",
 * "state"/"region"/"province", "country". Extra columns are preserved in
 * the raw jsonb column for audit.
 */

type Row = Record<string, string>;

const EMAIL_KEYS    = ['email', 'e-mail', 'email address', 'mail'];
const PHONE_KEYS    = ['phone', 'mobile', 'cell', 'telephone', 'tel'];
const FIRST_KEYS    = ['first_name', 'first name', 'firstname', 'fname', 'given name'];
const LAST_KEYS     = ['last_name', 'last name', 'lastname', 'lname', 'surname', 'family name'];
const COMPANY_KEYS  = ['company', 'organization', 'organisation', 'org', 'employer', 'account'];
const TITLE_KEYS    = ['title', 'job title', 'role', 'position'];
const CITY_KEYS     = ['city', 'locality', 'town'];
const REGION_KEYS   = ['state', 'region', 'province'];
const COUNTRY_KEYS  = ['country'];
const SEGMENT_KEYS  = ['icp_segment', 'segment'];
const SOURCE_KEYS   = ['source_url', 'source', 'lead_source', 'url'];

function pickKey(headers: string[], candidates: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().trim();
  const normalized = headers.map(norm);
  for (const c of candidates) {
    const i = normalized.indexOf(c);
    if (i >= 0) return headers[i];
  }
  // fallback: substring match (e.g. "Email Address" matches "email")
  for (const c of candidates) {
    const i = normalized.findIndex((h) => h.includes(c));
    if (i >= 0) return headers[i];
  }
  return undefined;
}

function mapRows(rows: Row[]): { raw: RawLead[]; mapping: Record<string, string | undefined> } {
  const headers = Object.keys(rows[0] ?? {});
  const mapping = {
    email:       pickKey(headers, EMAIL_KEYS),
    phone:       pickKey(headers, PHONE_KEYS),
    first_name:  pickKey(headers, FIRST_KEYS),
    last_name:   pickKey(headers, LAST_KEYS),
    company:     pickKey(headers, COMPANY_KEYS),
    title:       pickKey(headers, TITLE_KEYS),
    city:        pickKey(headers, CITY_KEYS),
    region:      pickKey(headers, REGION_KEYS),
    country:     pickKey(headers, COUNTRY_KEYS),
    icp_segment: pickKey(headers, SEGMENT_KEYS),
    source_url:  pickKey(headers, SOURCE_KEYS),
  } as const;

  const raw: RawLead[] = rows.map((r) => {
    const out: RawLead = {};
    for (const [dest, src] of Object.entries(mapping)) {
      if (src && r[src]) (out as Record<string, unknown>)[dest] = r[src].trim();
    }
    // Preserve every original column in raw for audit + unmapped fields.
    (out as Record<string, unknown>).raw = r;
    return out;
  });

  return { raw, mapping };
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'json').toLowerCase();

  const form = await req.formData();
  const file = form.get('file');
  const clientSlug = String(form.get('client_slug') ?? '').trim();
  const label = String(form.get('source_label') ?? '').trim() || `csv upload ${new Date().toISOString().slice(0, 10)}`;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file required' }, { status: 400 });
  }
  if (!clientSlug) {
    return NextResponse.json({ error: 'client_slug required' }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'file too large (10MB cap)' }, { status: 413 });
  }

  // Auth: the caller must own the target tenant (or be a platform admin).
  const userSupabase = await createClient();
  const { data: { user } } = await userSupabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: ownedClient } = await userSupabase
    .from('clients')
    .select('id, name, slug')
    .eq('slug', clientSlug)
    .maybeSingle();
  if (!ownedClient) {
    return NextResponse.json({ error: 'client not found or not accessible' }, { status: 404 });
  }

  const text = await file.text();
  const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length) {
    return NextResponse.json(
      { error: 'csv parse', details: parsed.errors.slice(0, 3) },
      { status: 400 }
    );
  }
  if (parsed.data.length === 0) {
    return NextResponse.json({ error: 'csv is empty' }, { status: 400 });
  }
  if (parsed.data.length > 10_000) {
    return NextResponse.json({ error: 'max 10,000 rows per upload' }, { status: 413 });
  }

  const { raw, mapping } = mapRows(parsed.data);
  if (!mapping.email && !mapping.phone) {
    return NextResponse.json(
      { error: 'could not find an email or phone column in CSV headers', headers: Object.keys(parsed.data[0] ?? {}) },
      { status: 400 }
    );
  }

  // Use the admin client for the actual scrub + write so suppressions / dedupe
  // joins + sources insert don't trip on RLS surprises. Ownership is already
  // enforced above via the user-scoped client.
  const supabase = createAdminClient();

  const { data: src } = await supabase
    .from('sources')
    .insert({
      client_id: ownedClient.id,
      kind: 'firstparty',
      label: `csv: ${label}`,
      source_url: `csv:${file.name}`,
    })
    .select('id')
    .single();

  const scrubbed = await scrubBatch(supabase as never, ownedClient.id, raw, { doEnrich: false });

  const inserts = scrubbed.map((s) =>
    buildLeadRow(s, {
      client_id: ownedClient.id,
      source_id: src?.id,
      // First-party: the customer uploaded this list themselves. Tier A.
      source_kind: 'firstparty',
      first_party: true,
    })
  );

  const { error: insertErr } = await supabase.from('leads').insert(inserts);
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  const summary = {
    ingested: inserts.length,
    eligible: inserts.filter((r) => r.export_eligibility === 'eligible').length,
    review: inserts.filter((r) => r.export_eligibility === 'review').length,
    quarantine: inserts.filter((r) => r.export_eligibility === 'quarantine').length,
    rejected: inserts.filter((r) => r.export_eligibility === 'rejected').length,
    mapping,
    source_id: src?.id,
  };

  if (format === 'csv') {
    const rows = inserts.map((r) => ({
      email: r.email ?? '',
      first_name: r.first_name ?? '',
      last_name: r.last_name ?? '',
      phone_e164: r.phone_e164 ?? '',
      company: r.company ?? '',
      title: r.title ?? '',
      city: r.city ?? '',
      region: r.region ?? '',
      country: r.country ?? '',
      verification_status: r.verification_status,
      quality_score: r.quality_score,
      export_eligibility: r.export_eligibility,
      reason_codes: (r.reason_codes ?? []).join(';'),
    }));
    const csv = Papa.unparse(rows);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${clientSlug}-verified-${new Date().toISOString().slice(0, 10)}.csv"`,
        'X-Verify-Summary': JSON.stringify({
          ingested: summary.ingested,
          eligible: summary.eligible,
        }),
      },
    });
  }

  return NextResponse.json(summary);
}
