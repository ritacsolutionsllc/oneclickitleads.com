import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

/** POST /api/dashboard/clients — creates a new tenant for the signed-in user. */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { name } = (await req.json()) as { name?: string };
  if (!name || !name.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  const { data, error } = await supabase
    .from('clients')
    .insert({ name: name.trim(), slug, owner_user: user.id, plan: 'starter' })
    .select('id, slug, name, plan')
    .single();

  if (error) {
    // unique violation — try a short suffix
    if (error.code === '23505') {
      const retrySlug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
      const { data: retry, error: retryErr } = await supabase
        .from('clients')
        .insert({ name: name.trim(), slug: retrySlug, owner_user: user.id, plan: 'starter' })
        .select('id, slug, name, plan')
        .single();
      if (retryErr) return NextResponse.json({ error: retryErr.message }, { status: 500 });
      return NextResponse.json(retry);
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
