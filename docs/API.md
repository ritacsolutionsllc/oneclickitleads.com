# OneClickitLeads API — Owner/Admin Usage Guide

Last updated: 2026-06-03

This API is for compliant, permission-based lead ingestion and operational integrations only. It must not be used for abusive scraping, unauthorized email harvesting, bypassing source terms, or collecting personal data from prohibited sources.

## Production API status

- GitHub source contains Next.js API routes.
- Current `oneclickit.info` production host returns `405 Method Not Allowed` for POST API calls, which means the source API routes are not currently exposed on that domain.
- Treat this document as the canonical source/API contract to deploy when the Next/Supabase backend is the active runtime.

## Authentication

Customer/owner API routes use an owner-generated API key.

Supported headers:

```http
Authorization: Bearer ocl_live_xxx
```

or:

```http
x-api-key: ocl_live_xxx
```

API keys are generated in the dashboard and stored hashed in Supabase (`api_keys.key_hash`). Growth, Agency, and Enterprise plans have API access. Starter does not.

## Endpoint: POST /api/v1/leads

Compliant lead ingestion endpoint. It does not scrape. It only processes rows the caller is permitted to submit.

### Request

```http
POST /api/v1/leads
Authorization: Bearer ocl_live_xxx
Content-Type: application/json
```

```json
{
  "source": {
    "kind": "firstparty",
    "label": "Shopify opt-in customer export — June 2026",
    "source_url": "shopify:customers.csv",
    "permission_basis": "First-party customer export from owned Shopify store with permitted operational use"
  },
  "rows": [
    {
      "email": "customer@example.com",
      "phone": "+15551234567",
      "first_name": "Jane",
      "last_name": "Doe",
      "company": "Jane Doe Studio",
      "title": "Owner",
      "city": "Austin",
      "region": "TX",
      "country": "US",
      "icp_segment": "b2c_beauty",
      "tags": ["shopify", "opted_in"]
    }
  ]
}
```

### Required fields

- `source.kind`: one of `firstparty`, `partner`, `licensed`, `manual`, `api`
- `source.permission_basis`: required compliance explanation
- `rows`: 1–100 records per request
- Each row needs at least one of: `email`, `phone`, or `company`

### Response

```json
{
  "client": "chella",
  "received": 1,
  "accepted": 1,
  "clean": 1,
  "rejected": 0,
  "source_id": "uuid"
}
```

### Errors

| Status | Meaning |
|--------|---------|
| 400 | Invalid request body, missing source metadata, unusable rows |
| 401 | Missing/invalid/revoked API key |
| 402 | Plan does not include API access |
| 409 | Duplicate or DB constraint conflict |
| 413 | More than 100 rows in one request |
| 500 | Server/database error |

## Internal endpoint: POST /api/ingest

Server-to-server only. Requires `x-ingest-secret`. Used for trusted internal jobs. Also requires `source.permission_basis` and maxes at 5,000 rows/request.

## Dashboard scrape proxy: POST /api/dashboard/scrape

Browser users should only trigger compliant collection through this authenticated proxy. It verifies:

1. Logged-in Supabase user
2. Client ownership
3. Agency+ plan for custom collection
4. Internal `x-ingest-secret` forwarding

Direct routes such as `/api/places-salons` are secret-gated and should not be exposed to browsers.

## Email handling policy

- Email is stored only when provided by first-party/licensed/permitted source or found through source-compliant owned/public business website processing.
- Suppression lists are applied before export.
- Duplicates are detected by normalized email hash and E.164 phone.
- Export only includes `is_scrubbed = true` leads and follows each client's export policy.
