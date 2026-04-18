---
name: nextjs15-migrate
description: Audit and migrate a Next.js codebase to the Next.js 15 async request APIs and lazy SDK initialization. Use when "Collecting page data" fails on Vercel, when cookies()/headers()/params are used synchronously, or when SDK clients (Stripe, Resend, etc.) are initialized at module level.
---

# Next.js 15 Migration Playbook

Use this skill when the Vercel build is failing or the codebase still uses pre-Next.js-15 patterns.

## Phase 1 — Scope the blast radius

Run these searches in parallel and report findings before changing anything:

1. **Sync `cookies()` / `headers()` usage**
   ```
   grep -rn "cookies()\." app/ utils/ lib/ components/
   grep -rn "headers()\." app/ utils/ lib/ components/
   ```
2. **Sync `searchParams` / `params`**
   ```
   grep -rn "searchParams\." app/ --include="page.tsx"
   grep -rn "params\." app/ --include="page.tsx" --include="route.ts"
   ```
3. **Module-level SDK initialization** (fails at build time when env vars missing)
   ```
   grep -rn "^const .* = new Stripe(" app/
   grep -rn "^const .* = new Resend(" app/
   grep -rn "^const .* = createClient(" app/ utils/ lib/
   ```
4. **Non-null env assertions** (should be explicit checks)
   ```
   grep -rn "process\.env\.[A-Z_]*!" app/ utils/ lib/
   ```

## Phase 2 — Apply the fixes

For each hit, apply the matching pattern:

### Async cookies/headers
```ts
// Before
export function createClient() {
  const cookieStore = cookies();
  ...
}

// After
export async function createClient() {
  const cookieStore = await cookies();
  ...
}
```
Then `await` every call site. Expect 10–20 call sites in a typical app.

### Async searchParams / params
```tsx
// Before
export default async function Page({ searchParams }: { searchParams: { q?: string } }) {
  const q = searchParams.q;
}

// After
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const q = sp.q;
}
```

### Lazy SDK initialization + env validation
```ts
// Before — fails during "Collecting page data"
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '...' });

// After — only runs when the handler is actually invoked
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key, { apiVersion: '...' });
}
```

### ESLint flat config with `eslint-config-next`
```js
// eslint.config.mjs
import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });
export default [
  { ignores: ['.next/**', 'node_modules/**'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];
```

## Phase 3 — Verify

Before opening the PR:

```bash
rm -rf .next
npm run build        # must pass with NO env vars set
npx tsc --noEmit     # no stale type errors
```

## Phase 4 — Commit + push

- One commit per concern: "migrate async APIs", "lazy-init Stripe", "eslint flat config"
- Branch name: `claude/nextjs15-migrate-<short-id>`
- Open PR as draft; wait for Vercel preview to go green before marking ready

## Common Vercel Agent flags

| Flag | Fix |
|---|---|
| Module-level `new Stripe()` | Wrap in `getStripe()` helper |
| `process.env.X!` non-null assertion | Explicit `if (!x) throw` |
| Arbitrary string accepted where enum expected | Validate against `as const` array with type guard |
| `cookies()` used synchronously | Make function `async`, `await` all call sites |
