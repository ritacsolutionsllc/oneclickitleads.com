import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { normalizeEmail } from '@/utils/scrub/email';

/**
 * POST /api/import/klaviyo
 *   body: { client_slug, kinds?: ("unsubscribed" | "bounced" | "spam")[] }
 *
 * Pulls Klaviyo profiles whose consent/deliverability status disqualifies
 * them from marketing and inserts them into the per-client `suppressions`
 * table. Idempotent — re-running merges new unsubs only.
 *
 * Klaviyo auth: private API key, header `Authorization: Klaviyo-API-Key <key>`
 * Klaviyo version: `revision: 2024-10-15`
 * Docs: https://developers.klaviyo.com/en/reference/get_profiles
 */
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const KLAVIYO_VER  = '2024-10-15';

type Kind = 'unsubscribed' | 'bounced' | 'spam';

const FILTER_BY_KIND: Record<Kind, string> = {
  unsubscribed: 'equals(subscriptions.email.marketing.consent,"UNSUBSCRIBED")',
  bounced:      'equals(subscriptions.email.marketing.suppression.reason,"HARD_BOUNCE")',
  spam:         'equals(subscriptions.email.marketing.suppression.reason,"SPAM_COMPLAINT")',
};

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-ingest-secret');
  if (secret !== process.env.INGEST_SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { client_slug, kinds = ['unsubscribed', 'bounced', 'spam'] } = (await req.json()) as {
    client_slug: string;
    kinds?: Kind[];
  };

  const key = process.env.KLAVIYO_API_KEY;
  if (!key) return NextResponse.json({ error: 'KLAVIYO_API_KEY missing' }, { status: 500 });

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', client_slug).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  let totalAdded = 0;
  const perKind: Record<string, number> = {};

  for (const kind of kinds) {
    const filter = FILTER_BY_KIND[kind];
    let next: string | null = `${KLAVIYO_BASE}/profiles?filter=${encodeURIComponent(filter)}&page[size]=100`;
    let added = 0;

    while (next) {
      const r: Response = await fetch(next, {
        headers: {
          Authorization: `Klaviyo-API-Key ${key}`,
          accept: 'application/json',
          revision: KLAVIYO_VER,
        },
      });
      if (!r.ok) {
        return NextResponse.json(
          { error: `Klaviyo ${kind}: HTTP ${r.status}`, detail: await r.text() },
          { status: 502 }
        );
      }
      const data = (await r.json()) as {
        data?: { attributes?: { email?: string; phone_number?: string } }[];
        links?: { next?: string | null };
      };

      const rows = (data.data ?? [])
        .map((p) => ({
          client_id: client.id,
          email: p.attributes?.email ? normalizeEmail(p.attributes.email) : null,
          phone: p.attributes?.phone_number ?? null,
          reason: kind,
        }))
        .filter((r) => r.email || r.phone);

      if (rows.length) {
        const { error } = await supabase.from('suppressions').insert(rows);
        if (error && !String(error.message).includes('duplicate')) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
        added += rows.length;
      }
      next = data.links?.next ?? null;
    }

    perKind[kind] = added;
    totalAdded += added;
  }

  return NextResponse.json({
    client: client_slug,
    suppressions_added: totalAdded,
    per_kind: perKind,
  });
}
