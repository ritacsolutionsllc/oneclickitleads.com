import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';

export default function SubmitLead({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  async function submit(formData: FormData) {
    'use server';
    const supabase = createClient();

    // Look up client by slug (from ?client=chella)
    const slug = (formData.get('client_slug') as string) || searchParams.client || '';
    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('slug', slug)
      .single();

    if (!client) throw new Error('Unknown client');

    const email = (formData.get('email') as string)?.trim().toLowerCase();
    const first_name = formData.get('first_name') as string;
    const last_name = formData.get('last_name') as string;
    const phone = formData.get('phone') as string;
    const icp_segment = (formData.get('icp_segment') as string) || 'b2c_beauty';

    const { error } = await supabase.from('leads').insert({
      client_id: client.id,
      email,
      first_name,
      last_name,
      phone_e164: phone || null,
      icp_segment,
      raw: Object.fromEntries(formData.entries()),
    });
    if (error) throw error;
    redirect('/submit-lead/thanks');
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <h1 className="text-3xl font-semibold">Join the list</h1>
      <p className="text-neutral-600 mt-2">
        We use your info only to send you offers from the brand you're signing
        up with. Unsubscribe any time.
      </p>

      <form action={submit} className="mt-8 space-y-4">
        <input
          type="hidden"
          name="client_slug"
          defaultValue={searchParams.client ?? 'chella'}
        />

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-neutral-700">First name</span>
            <input
              required name="first_name"
              className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2"
            />
          </label>
          <label className="block">
            <span className="text-sm text-neutral-700">Last name</span>
            <input
              name="last_name"
              className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm text-neutral-700">Email</span>
          <input
            required type="email" name="email"
            className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-700">Phone (optional)</span>
          <input
            name="phone"
            className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-700">I am a...</span>
          <select
            name="icp_segment"
            className="mt-1 w-full rounded-lg border-neutral-300 border px-3 py-2 bg-white"
          >
            <option value="b2c_beauty">Beauty shopper</option>
            <option value="salon">Salon / spa owner</option>
            <option value="retailer">Retailer / buyer</option>
            <option value="influencer">Creator / influencer</option>
          </select>
        </label>

        <label className="flex items-start gap-2 text-xs text-neutral-600">
          <input required type="checkbox" name="consent" className="mt-1" />
          I agree to receive marketing emails and understand I can unsubscribe
          at any time. See the <a className="underline" href="/privacy">privacy policy</a>.
        </label>

        <button className="w-full rounded-full bg-emerald-600 text-white py-3 font-medium hover:bg-emerald-700">
          Submit
        </button>
      </form>
    </main>
  );
}
