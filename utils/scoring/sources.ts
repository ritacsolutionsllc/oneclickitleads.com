// Canonical mapping from source.kind / origin → trust tier (1..5).
//
// Used by every ingest route so source_confidence is computed consistently.
// 1 = first-party opt-in / paying customer
// 2 = api-verified (Apollo, Common Room, Hunter person finder)
// 3 = enriched (Hunter domain search, Apollo person/company match)
// 4 = public-scraped (Google Places, OSM, Yelp, generic scraped HTML)
// 5 = social-speculative (instagram bios, follower lists)

export type SourceKind =
  | 'firstparty'
  | 'optin'
  | 'apollo'
  | 'commonroom'
  | 'api'
  | 'enriched'
  | 'hunter'
  | 'snov'
  | 'google_places'
  | 'osm'
  | 'scraped'
  | 'webscrapingai'
  | 'yelp'
  | 'purchased'
  | 'social'
  | 'instagram'
  | 'tiktok';

const TIER_BY_KIND: Record<string, number> = {
  firstparty: 1,
  optin: 1,
  apollo: 2,
  commonroom: 2,
  api: 2,
  hunter: 3,
  snov: 3,
  enriched: 3,
  google_places: 4,
  osm: 4,
  scraped: 4,
  webscrapingai: 4,
  yelp: 4,
  purchased: 4,
  social: 5,
  instagram: 5,
  tiktok: 5,
};

const DEFAULT_TIER = 4;

/**
 * Map a source.kind (or arbitrary label) to a trust tier in [1,5].
 * Falls back to 4 (public-scraped) for unknown kinds — quality-first
 * default is "treat unknowns as untrusted until proven otherwise".
 */
export function trustTierForSource(kind?: string | null): number {
  if (!kind) return DEFAULT_TIER;
  const lower = kind.trim().toLowerCase();
  return TIER_BY_KIND[lower] ?? DEFAULT_TIER;
}

/** Inverse — useful for surfacing the tier name in admin tooling. */
export function sourceTierLabel(tier: number): string {
  switch (tier) {
    case 1: return 'first-party opt-in';
    case 2: return 'api-verified';
    case 3: return 'enriched';
    case 4: return 'public-scraped';
    case 5: return 'social-speculative';
    default: return 'unknown';
  }
}
