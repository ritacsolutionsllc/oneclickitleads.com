import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { hasMxRecord, hasValidSyntax, isDisposable, normalizeEmail, smtpVerify } from '@/utils/scrub/email';
import { scoreLead, toLeadColumns, type SourceKind } from '@/utils/scoring/quality';

export const runtime = 'nodejs';

/**
 * POST /api/reverify
 *   headers: { x-ingest-secret: $INGEST_SECRET }
 *   body: {
 *     client_slug?: string,        // scope to one client; omit for all
 *     older_than_days?: number,    // default 7
 *     limit?: number,              // default 500 (per call)
 *     states?: ('review'|'quarantine')[]  // default ['review','quarantine']
 *   }
 *
 * Re-runs syntax/MX/SMTP on leads that are stuck out of the export gate,
 * then reruns the canonical scoring engine. Rows that pass get promoted to
 * `export_eligibility='eligible'`; rows that stay weak keep their state but
 * get a fresh `last_verified_at` so the review queue prioritizes newer
 * failures. Hard-rejected rows are never touched.
 *
 * Wire this to a Vercel Cron (or any scheduled HTTP call) to close the
 * feedback loop on quality — borderline rows graduate without operators
 * clicking through the queue.
 */

const DEFAULT_STATES = ['review', 'quarantine'] as const;
type State = typeof DEFAULT_STATES[number];

interface LeadRow {
  id: string;
  email: string | null;
  phone_e164: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  icp_segment: string | null;
  tags: string[] | null;
  source_url: string | null;
  source_id: string | null;
  is_duplicate: boolean | null;
  is_suppressed: boolean | null;
  export_eligibility: string | null;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const {
    client_slug,
    older_than_days = 7,
    limit = 500,
    states,
  } = (await req.json().catch(() => ({}))) as {
    client_slug?: string;
    older_than_days?: number;
    limit?: number;
    states?: State[];
  };

  const targetStates: State[] = Array.isArray(states) && states.length
    ? states.filter((s): s is State => (DEFAULT_STATES as readonly string[]).includes(s))
    : [...DEFAULT_STATES];

  if (targetStates.length === 0) {
    return NextResponse.json({ error: 'no valid states' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - older_than_days * 86_400_000).toISOString();

  let clientId: string | null = null;
  if (client_slug) {
    const { data: c } = await supabase
      .from('clients').select('id').eq('slug', client_slug).single();
    if (!c) return NextResponse.json({ error: 'unknown client' }, { status: 404 });
    clientId = c.id;
  }

  let q = supabase
    .from('leads')
    .select(
      'id, email, phone_e164, first_name, last_name, company, title, city, region, country, icp_segment, tags, source_url, source_id, is_duplicate, is_suppressed, export_eligibility'
    )
    .in('export_eligibility', targetStates)
    .or(`last_verified_at.lt.${cutoff},last_verified_at.is.null`)
    .limit(Math.min(limit, 2000));
  if (clientId) q = q.eq('client_id', clientId);

  const { data: leads, error: qErr } = await q;
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });

  const rows = (leads ?? []) as LeadRow[];
  if (rows.length === 0) {
    return NextResponse.json({ reverified: 0, promoted: 0, kept: 0 });
  }

  // Source-kind lookup so rescore preserves tier lineage.
  const sourceIds = Array.from(new Set(rows.map((r) => r.source_id).filter((x): x is string => !!x)));
  const kindById = new Map<string, SourceKind>();
  if (sourceIds.length) {
    const { data: srcs } = await supabase
      .from('sources').select('id, kind').in('id', sourceIds);
    for (const s of srcs ?? []) kindById.set(s.id, s.kind as SourceKind);
  }

  let promoted = 0;
  let kept = 0;
  const now = new Date();

  for (const r of rows) {
    const email = r.email ? normalizeEmail(r.email) : '';
    let syntax_valid: boolean | null = null;
    let mx_valid: boolean | null = null;
    let smtp_valid: boolean | null = null;
    let disposable: boolean | null = null;

    if (email) {
      syntax_valid = hasValidSyntax(email);
      disposable = syntax_valid ? isDisposable(email) : false;
      if (syntax_valid && !disposable) {
        mx_valid = await hasMxRecord(email);
        if (mx_valid) {
          const { valid } = await smtpVerify(email);
          smtp_valid = valid;
        } else {
          smtp_valid = false;
        }
      } else {
        mx_valid = false;
        smtp_valid = false;
      }
    }

    const source_kind = r.source_id ? kindById.get(r.source_id) : undefined;
    const verdict = scoreLead({
      syntax_valid,
      mx_valid,
      smtp_valid,
      is_disposable: disposable,
      is_duplicate: r.is_duplicate ?? false,
      is_suppressed: r.is_suppressed ?? false,
      email: email || null,
      phone_e164: r.phone_e164,
      first_name: r.first_name,
      last_name: r.last_name,
      company: r.company,
      title: r.title,
      city: r.city,
      region: r.region,
      country: r.country,
      source_url: r.source_url,
      icp_segment: r.icp_segment,
      tags: r.tags ?? [],
      source_kind,
      last_verified_at: now,
    });

    const patch = toLeadColumns(verdict, now);
    // Also sync the legacy SMTP columns so the old scrub views stay honest.
    await supabase
      .from('leads')
      .update({
        ...patch,
        syntax_valid,
        mx_valid,
        smtp_valid,
      })
      .eq('id', r.id);

    if (verdict.export_eligibility === 'eligible' && r.export_eligibility !== 'eligible') {
      promoted++;
    } else {
      kept++;
    }
  }

  return NextResponse.json({
    reverified: rows.length,
    promoted,
    kept,
    older_than_days,
    states: targetStates,
  });
}
