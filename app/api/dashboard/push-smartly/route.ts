import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';

/**
 * Dashboard-facing proxy to /api/push/smartly.
 * Verifies the user owns the client, then calls the S2S endpoint with
 * the INGEST_SECRET server-side so we never expose it to the browser.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json();
  const { client_slug } = body;
  if (!client_slug) return NextResponse.json({ error: 'client_slug required' }, { status: 400 });

  // Verify ownership
  const admin = createAdminClient();
  const { data: client } = await admin
    .from('clients')
    .select('id, owner_user')
    .eq('slug', client_slug)
    .single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });
  if (client.owner_user !== user.id)
    return NextResponse.json({ error: 'not your client' }, { status: 403 });

  // Proxy
  const resp = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/push/smartly`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ingest-secret': process.env.INGEST_SECRET ?? '',
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  return NextResponse.json(data, { status: resp.status });
}
