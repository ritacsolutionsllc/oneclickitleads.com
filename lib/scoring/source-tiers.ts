/**
 * Source-tier policy.
 *
 * We trust first-party data the most, paid/verified B2B databases second,
 * and public/scraped sources the least. The scoring engine consumes this
 * map to decide how much of a "free ride" each row gets before it has to
 * earn export eligibility on other signals.
 */

export type SourceTier = 'tier1' | 'tier2' | 'tier3';

/**
 * Keep this table in sync with the `sources.kind` values written by the
 * ingest routes. Unknown kinds fall through to tier3 — the safe default
 * since it's the strictest export gate.
 */
const KIND_TO_TIER: Record<string, SourceTier> = {
  // tier1: first-party / already-consented data
  firstparty: 'tier1',
  shopify: 'tier1',
  klaviyo: 'tier1',
  self_signup: 'tier1',        // /submit-lead form with explicit consent
  api: 'tier1',                // server-to-server from an authenticated client

  // tier2: paid B2B DBs + verified directories
  apollo: 'tier2',
  commonroom: 'tier2',
  hunter: 'tier2',
  snov: 'tier2',
  zoominfo: 'tier2',
  purchased: 'tier2',

  // tier3: public / scraped / directory data
  scraped: 'tier3',
  google_places: 'tier3',
  osm: 'tier3',
  webscraping_ai: 'tier3',
  yelp: 'tier3',
  instagram: 'tier3',
};

export function sourceKindToTier(kind: string): SourceTier {
  return KIND_TO_TIER[kind.toLowerCase()] ?? 'tier3';
}

export function isPublicSource(kind: string): boolean {
  return sourceKindToTier(kind) === 'tier3';
}
