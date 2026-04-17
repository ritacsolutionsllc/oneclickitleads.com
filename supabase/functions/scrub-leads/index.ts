// Supabase Edge Function: re-scrub leads on a schedule (pg_cron or manual invoke)
// Deploy: supabase functions deploy scrub-leads
//
// Called nightly by pg_cron to re-verify leads that are older than 30 days.
// This keeps list hygiene high without paying to re-verify fresh records.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { client_slug, older_than_days = 30, limit = 5000 } = await req.json();

  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', client_slug).single();
  if (!client) return new Response('no client', { status: 404 });

  const cutoff = new Date(Date.now() - older_than_days * 86400_000).toISOString();

  const { data: leads } = await supabase
    .from('leads')
    .select('id, email')
    .eq('client_id', client.id)
    .lt('scrubbed_at', cutoff)
    .limit(limit);

  const nb = Deno.env.get('NEVERBOUNCE_API_KEY');
  let updated = 0;

  for (const l of leads ?? []) {
    if (!nb || !l.email) continue;
    const r = await fetch(
      `https://api.neverbounce.com/v4/single/check?key=${nb}&email=${encodeURIComponent(l.email)}`
    );
    const d = await r.json();
    const valid = d.result === 'valid';
    await supabase
      .from('leads')
      .update({
        smtp_valid: valid,
        is_scrubbed: valid,
        scrub_score: valid ? 100 : 40,
        scrubbed_at: new Date().toISOString(),
        reject_reason: valid ? null : 'smtp_failed_reverify',
      })
      .eq('id', l.id);
    updated++;
  }

  return new Response(JSON.stringify({ updated }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
