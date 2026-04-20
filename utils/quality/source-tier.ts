/**
 * Source tier mapping — single source of truth for how confident we are
 * in the provenance of a lead. Used by the scoring engine and by every
 * ingestion route when it inserts a `sources` row.
 *
 * Lower tiers default to `quarantined` in the export-eligibility gate
 * unless the scoring engine can prove independent verification (SMTP).
 */

export type SourceTier =
  | 'first_party'
  | 'verified_directory'
  | 'enriched'
  | 'scraped'
  | 'purchased'
  | 'unknown';

/** Source.kind values that have ever been written by an ingestion route. */
export type SourceKind =
  | 'firstparty'
  | 'first_party'
  | 'apollo'
  | 'commonroom'
  | 'common_room'
  | 'hunter'
  | 'snov'
  | 'enriched'
  | 'google_places'
  | 'places'
  | 'osm'
  | 'webscraping'
  | 'webscraping.ai'
  | 'scraped'
  | 'purchased'
  | 'csv'
  | 'api'
  | string;

const KIND_TO_TIER: Record<string, SourceTier> = {
  firstparty: 'first_party',
  first_party: 'first_party',
  shopify: 'first_party',
  klaviyo: 'first_party',
  apollo: 'enriched',
  commonroom: 'enriched',
  common_room: 'enriched',
  hunter: 'enriched',
  snov: 'enriched',
  enriched: 'enriched',
  google_places: 'verified_directory',
  places: 'verified_directory',
  osm: 'scraped',
  webscraping: 'scraped',
  'webscraping.ai': 'scraped',
  scraped: 'scraped',
  purchased: 'purchased',
};

export function tierForSourceKind(kind: string | null | undefined): SourceTier {
  if (!kind) return 'unknown';
  return KIND_TO_TIER[kind.toLowerCase()] ?? 'unknown';
}

/** Human-readable label for the dashboard. */
export function tierLabel(tier: SourceTier): string {
  switch (tier) {
    case 'first_party':        return 'First-party';
    case 'verified_directory': return 'Verified directory';
    case 'enriched':           return 'Enriched';
    case 'scraped':            return 'Scraped';
    case 'purchased':          return 'Purchased';
    default:                   return 'Unknown';
  }
}
