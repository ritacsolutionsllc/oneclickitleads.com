import { createClient } from '@/utils/supabase/server';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Proof of consent — OneClickitLeads',
  robots: { index: false, follow: false },
};

/**
 * GET /proof/<lead_id>
 *
 * Owner-gated proof-of-consent page. Returns the structured consent record
 * a compliance reviewer (Meta, TikTok, CCPA auditor) asks for when they
 * want evidence a specific recipient opted in.
 *
 * Access control:
 *   - Requires an authenticated Supabase session.
 *   - RLS on `leads` enforces tenant isolation — a client only ever sees
 *     rows where clients.owner_user = auth.uid(). Same for lead_events.
 *   - If the lead has no consent_ts, we 404 rather than render a blank
 *     page. "No proof" is a useful signal on its own.
 */
export default async function ProofPage({
  params,
}: {
  params: Promise<{ lead_id: string }>;
}) {
  const { lead_id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/proof/${lead_id}`)}`);
  }

  const { data: lead } = await supabase
    .from('leads')
    .select(
      'id, email, first_name, last_name, icp_segment, consent_ts, consent_ip, consent_ua, consent_text_version, consent_source_url, client_id'
    )
    .eq('id', lead_id)
    .maybeSingle();

  if (!lead || !lead.consent_ts) notFound();

  const { data: events } = await supabase
    .from('lead_events')
    .select('created_at, detail')
    .eq('lead_id', lead.id)
    .eq('kind', 'consented')
    .order('created_at', { ascending: true })
    .limit(1);
  const event = events?.[0];
  const consentText = (event?.detail as { text?: string } | null)?.text ?? null;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Proof of consent</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Lead <code className="font-mono text-xs">{lead.id}</code>
      </p>

      <dl className="mt-8 grid grid-cols-[auto,1fr] gap-x-6 gap-y-3 text-sm">
        <dt className="text-neutral-500">Recipient</dt>
        <dd className="font-medium">
          {[lead.first_name, lead.last_name].filter(Boolean).join(' ') || '—'}
          {lead.email ? ` <${lead.email}>` : ''}
        </dd>

        <dt className="text-neutral-500">ICP segment</dt>
        <dd>{lead.icp_segment ?? '—'}</dd>

        <dt className="text-neutral-500">Consented at</dt>
        <dd>
          <time dateTime={lead.consent_ts}>
            {new Date(lead.consent_ts).toUTCString()}
          </time>
        </dd>

        <dt className="text-neutral-500">Source URL</dt>
        <dd className="break-all">
          {lead.consent_source_url ? (
            <a
              className="underline"
              href={lead.consent_source_url}
              target="_blank"
              rel="noreferrer"
            >
              {lead.consent_source_url}
            </a>
          ) : (
            '—'
          )}
        </dd>

        <dt className="text-neutral-500">IP at consent</dt>
        <dd className="font-mono">{lead.consent_ip ?? '—'}</dd>

        <dt className="text-neutral-500">User-Agent</dt>
        <dd className="break-all font-mono text-xs">
          {lead.consent_ua ?? '—'}
        </dd>

        <dt className="text-neutral-500">Consent text version</dt>
        <dd className="font-mono">{lead.consent_text_version ?? '—'}</dd>

        {consentText && (
          <>
            <dt className="text-neutral-500">Consent text</dt>
            <dd className="italic">{consentText}</dd>
          </>
        )}
      </dl>

      <p className="mt-10 text-xs text-neutral-500">
        This page is access-restricted to the account that owns the
        originating client. Share the URL only with auditors or channel
        partners performing a compliance review.
      </p>
    </main>
  );
}
