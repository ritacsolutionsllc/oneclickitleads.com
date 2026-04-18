import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { client_slug, url, events } = (await req.json()) as {
    client_slug: string; url: string; events: string[];
  };
  try { new URL(url); } catch { return NextResponse.json({ error: 'invalid url' }, { status: 400 }); }

  const admin = createAdminClient();
  const { data: client } = await admin
    .from('clients').select('id, owner_user').eq('slug', client_slug).single();
  if (!client || client.owner_user !== user.id)
    return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');

  const { data: row, error } = await admin
    .from('webhooks')
    .insert({ client_id: client.id, url, events, secret, active: true })
    .select('id, url, events, active, created_at').single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ row, secret });
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await supabase.from('webhooks').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: id });
}
