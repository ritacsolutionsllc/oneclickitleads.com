# CLAUDE.md — OneClickitLeads

Operating notes for Claude Code when working on this repo. Read this before
touching code.

## Stack

- Next.js 15 (App Router, Server Components, async request APIs)
- TypeScript strict, ESLint 9 flat config (`eslint.config.mjs` uses `FlatCompat`)
- Supabase (Postgres + Auth + RLS)
- Stripe (subscriptions + billing portal + webhooks)
- Resend (transactional email for `/api/contact` and DSAR submissions)
- Vercel (deploy + preview environments)

## Next.js 15 Conventions

- `cookies()`, `headers()`, `params`, and `searchParams` are **async** — always `await` them.
- `utils/supabase/server.ts#createClient` is async; every call site must `await createClient()`.
- Route handler pages that take `searchParams` must type them as `Promise<{...}>` and await before use.
- Never initialize SDK clients (Stripe, Resend, third-party APIs) at module level. Use a lazy helper inside the handler:
  ```ts
  function getStripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    return new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  }
  ```
  Module-level init fails during Vercel's "Collecting page data" phase when env vars aren't populated, and the Vercel Agent reviewer flags it every time.
- Validate required env vars with an explicit `if (!key) throw` rather than a non-null assertion (`!`). Same rule applies to `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, etc.
- For user input hitting API routes: length-cap strings (`.slice(0, N)`), reject invalid enums with a 400 listing the allowed values, and HTML-escape anything echoed back into email bodies.

## Git Hygiene

- Before declaring a task complete, run `git status` and ensure there are no
  untracked or uncommitted files relevant to the change. The `Stop` hook in
  `.claude/settings.json` will warn if untracked files remain.
- When a PR develops merge conflicts after a parallel PR merges, prefer closing
  the stale PR and opening a fresh one off the latest `main` with only the
  unique deltas. Attempting a complex rebase buries reviewers in conflict noise.
- Before opening a new PR, run `gh pr list` (or `mcp__github__list_pull_requests`)
  to check for open PRs that touch overlapping files; note the dependency in
  the PR description if overlap exists.

## Build Validation

- After any change that touches API routes, env var usage, or SDK
  initialization, run a local `npm run build` before opening a PR. The build
  must pass with **no env vars set** — if it doesn't, something is
  initializing at module level.
- Check Vercel bot review comments on every PR and address them in the **same**
  PR rather than a follow-up. Common flags:
  - Module-level SDK init → refactor to lazy helper
  - `process.env.X!` → replace with explicit validation
  - Arbitrary string input → validate against an enum
- ESLint rules that are intentionally off (we bumped them in #5): `react/no-unescaped-entities`, `@typescript-eslint/no-explicit-any`. Don't re-enable these without discussion.

## Branching

- Feature branches: `claude/<short-description>`
- Base: always branch off latest `main`, never off another open PR's branch
- PRs open as **draft** first; mark ready when CI + Vercel are green

## Environment variables

Required vs. optional env vars are documented in `docs/env-vars.md`, including
signup links for every third-party service. Keep `.env.example` in sync with
that doc.

## Optional tooling

- **Vercel MCP** — not installed by default. If you want Claude to inspect
  build logs directly, run:
  ```
  claude mcp add vercel -- npx -y @vercel/mcp-server --token $VERCEL_TOKEN
  ```
- **Autonomous PR review loop** — scaffolding lives in
  `.claude/skills/pr-review/`. To run it as a GitHub Action on
  `pull_request_review_comment`, create a workflow that shells out to
  `claude -p` (headless mode) with that skill; not enabled in CI by default
  because it consumes Claude API credits.

## Skills available

- `/nextjs15-migrate` — bulk-convert sync cookies/headers/params + lazy-init SDK clients
- `/pr-review` — fetch review comments, categorize, fix, verify build, reply
- `/preflight` — parallel subagents scan staged diff for known failure classes
