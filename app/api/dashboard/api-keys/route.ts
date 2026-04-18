import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { client_slug, label } = (await req.json()) as { client_slug: string; label?: string };
  const admin = createAdminClient();
  const { data: client } = await admin
    .from('clients').select('id, owner_user, plan').eq('slug', client_slug).single();
  if (!client || client.owner_user !== user.id)
    return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  // Generate: ocl_live_<32 random bytes>
  const raw = 'ocl_live_' + crypto.randomBytes(24).toString('base64url');
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 14);

  const { data: row, error } = await admin
    .from('api_keys')
    .insert({ client_id: client.id, key_hash: keyHash, key_prefix: prefix, label: label ?? null })
    .select('id, key_prefix, label, last_used, created_at, revoked_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ key: raw, row });
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ revoked: id });
}
