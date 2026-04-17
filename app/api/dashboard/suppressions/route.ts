import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { normalizeEmail } from '@/utils/scrub/email';
import { normalizePhone } from '@/utils/scrub/phone';

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { client_slug, entries, reason } = (await req.json()) as {
    client_slug: string; entries: string[]; reason?: string;
  };

  const { data: client } = await supabase
    .from('clients').select('id').eq('slug', client_slug).eq('owner_user', user.id).single();
  if (!client) return NextResponse.json({ error: 'unknown client' }, { status: 404 });

  const rows = entries.map((v) => {
    if (v.includes('@')) return { client_id: client.id, email: normalizeEmail(v), reason: reason ?? 'other' };
    return { client_id: client.id, phone: normalizePhone(v), reason: reason ?? 'other' };
  }).filter((r) => r.email || r.phone);

  const { data, error } = await supabase
    .from('suppressions').insert(rows).select();
  if (error && !String(error.message).includes('duplicate'))
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ added: data?.length ?? 0, rows: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  // RLS on suppressions restricts to rows where the client belongs to this user.
  const { error } = await supabase.from('suppressions').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: id });
}
