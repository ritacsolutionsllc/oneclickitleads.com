/**
 * Shared vocabulary for the quality-first lead pipeline. These unions mirror
 * the check constraints in supabase/migrations/0005_quality_first.sql — if
 * you add a value here, update the migration and back-fill first or inserts
 * will be rejected at the database boundary.
 */

export type VerificationStatus =
  | 'unverified'
  | 'mx_only'
  | 'smtp_verified'
  | 'manual_verified'
  | 'bounced';

export type SourceTier =
  | 'unknown'
  | 'firstparty'
  | 'verified_api'
  | 'public_directory'
  | 'scraped'
  | 'purchased';

export type ReviewState =
  | 'ready'
  | 'review'
  | 'quarantined'
  | 'approved'
  | 'discarded';

/**
 * The `sources.kind` values we know how to map to a tier. Anything else
 * resolves to `source_tier = 'unknown'`, which the scoring engine treats
 * with the lowest confidence.
 */
export type SourceKind =
  | 'firstparty'
  | 'shopify'
  | 'klaviyo'
  | 'opt_in'
  | 'apollo'
  | 'commonroom'
  | 'hunter'
  | 'snov'
  | 'zoominfo'
  | 'api'
  | 'google_places'
  | 'osm'
  | 'places'
  | 'scrapingbee'
  | 'brightdata'
  | 'webscraping.ai'
  | 'webscraping_ai'
  | 'scraped'
  | 'purchased';
