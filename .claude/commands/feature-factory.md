---
description: Test-driven feature development — generate Playwright tests first, then parallel agents implement UI / API / data layer until tests pass.
---

# /feature-factory

Build a complete feature test-first. Acceptance criteria → Playwright specs → parallel implementation agents → green tests → draft PR.

## Usage

```
/feature-factory "User profile page with avatar upload, bio editing, and email-change flow"
```

## Workflow

### 1. Parse the spec
Extract: routes, data entities, validations, accessibility requirements, and responsive breakpoints. If anything is ambiguous, ask the user **once** before generating tests.

### 2. Generate Playwright tests (commit first, RED)
Under `tests/e2e/<feature-slug>.spec.ts`:
- Happy path (every interaction works)
- Validation errors (required fields, invalid email, etc.)
- Accessibility (inject `axe-core`, no critical violations)
- Mobile responsive (375px viewport smoke check)
- Any integration points mentioned in the spec

Commit these tests with `test: add failing specs for <feature>`. They should fail until implementation lands.

### 3. Launch parallel implementation agents

Spawn three `Agent` tool calls in a single message:

- **UI agent** (subagent_type `general-purpose`) — build the React components, use existing Tailwind + shadcn patterns in the repo, respect `SiteShell` for marketing pages / `DashboardNav` for authed pages.
- **API agent** — build `/api/<route>` handlers following repo conventions (lazy SDK init, env validation, enum guards for input).
- **Data agent** — Supabase migration under `supabase/migrations/` if new tables/columns are needed, RLS policies, and any required view updates.

Each agent gets: the spec, the path to the failing tests, and explicit permission to edit only their layer.

### 4. Iterate against the tests

Loop up to 10 cycles:
1. Run `npx playwright test tests/e2e/<feature-slug>.spec.ts`
2. If green → stop, proceed to step 5.
3. Otherwise pipe the failure output to the relevant agent for a targeted fix.

### 5. Verify build + open PR

- `npm run build` must pass
- `git status` must be clean
- Open a draft PR with: spec, list of tests, iteration count, and any deferred TODOs.

## Guardrails

- Max 10 iteration cycles — if still red, summarize remaining failures to the user and stop.
- Never skip or mark tests `.skip` to make them pass.
- Never modify auth, payment, or webhook routes without user confirmation.
- Accessibility failures are **blocking**, not warnings.

## Prerequisites

Before first run, install Playwright:
```bash
npm install -D @playwright/test @axe-core/playwright
npx playwright install --with-deps chromium
```

Add a basic `playwright.config.ts` pointing at `http://localhost:3000` with `webServer: { command: 'npm run dev' }`.
