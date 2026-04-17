// Enrichment against Hunter.io + Apollo.
// Non-blocking — if a provider fails, we return partial data rather than rejecting the lead.

export interface EnrichedLead {
  first_name?: string;
  last_name?: string;
  email?: string;
  title?: string;
  company?: string;
  linkedin_url?: string;
  city?: string;
  region?: string;
  country?: string;
}

export async function enrichViaHunter(
  email: string
): Promise<EnrichedLead | null> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;
  const url = `https://api.hunter.io/v2/email-finder?email=${encodeURIComponent(email)}&api_key=${key}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const { data } = (await r.json()) as {
      data?: {
        first_name?: string; last_name?: string; position?: string;
        company?: string; linkedin_url?: string;
      };
    };
    if (!data) return null;
    return {
      first_name: data.first_name,
      last_name: data.last_name,
      title: data.position,
      company: data.company,
      linkedin_url: data.linkedin_url,
    };
  } catch {
    return null;
  }
}

export async function enrichViaApollo(
  email: string
): Promise<EnrichedLead | null> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({ email }),
    });
    if (!r.ok) return null;
    const { person } = (await r.json()) as {
      person?: {
        first_name?: string; last_name?: string; title?: string;
        organization?: { name?: string };
        linkedin_url?: string;
        city?: string; state?: string; country?: string;
      };
    };
    if (!person) return null;
    return {
      first_name: person.first_name,
      last_name: person.last_name,
      title: person.title,
      company: person.organization?.name,
      linkedin_url: person.linkedin_url,
      city: person.city,
      region: person.state,
      country: person.country,
    };
  } catch {
    return null;
  }
}

// Run both in parallel, merge, preferring Apollo (usually richer for B2B)
export async function enrich(email: string): Promise<EnrichedLead> {
  const [h, a] = await Promise.all([enrichViaHunter(email), enrichViaApollo(email)]);
  return { ...(h ?? {}), ...(a ?? {}) };
}
