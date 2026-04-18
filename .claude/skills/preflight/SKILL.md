---
name: preflight
description: Run a parallel preflight audit of staged changes before opening a PR — checks for Vercel-build-breaking patterns (module-level SDK init, sync cookies/headers/params, missing env validation) and runs a local build. Use before every `git push` of a PR-bound branch.
---

# Preflight Build Validator

Run 4 specialist checks in parallel against the staged diff, aggregate the results, and fail fast on "critical" findings before the PR is opened.

## Trigger

Invoke before `git push` when the branch is going to become a PR. The `/preflight` command is the canonical entry point.

## Parallel subagents

Spawn all four via the `Agent` tool in a single message (use `Explore` subagent_type for each):

### 1. Next.js 15 async API checker
Prompt:
> Scan the staged diff (`git diff --cached`) for sync uses of `cookies()`, `headers()`, `params.`, `searchParams.`. Any match where the surrounding context doesn't await is a **critical** finding. Also flag non-async functions that use these. Return: file:line + the offending snippet. Under 200 words.

### 2. Module-level side-effect auditor
Prompt:
> Scan the staged diff (`git diff --cached`) and the full files it touches. Flag any top-level (module-scope) construction of: `new Stripe(`, `new Resend(`, `new OpenAI(`, `createClient(` from Supabase, or any other SDK client that reads from `process.env`. Each match is **critical**. Safe equivalents: `function getX() { ... }` helpers. Return file:line. Under 200 words.

### 3. Env var auditor
Prompt:
> Compare `process.env.X` references in the staged diff against `.env.example`. Any env var used in code but not documented → **warning**. Any `process.env.X!` non-null assertion → **critical** (should be explicit `if (!x) throw`). Return two lists: undocumented vars, and non-null assertions. Under 200 words.

### 4. Strict TS / ESLint simulator
Prompt:
> Run `npx tsc --noEmit` and `npm run lint` (if it exists) against the current working tree. Report any errors (critical) or warnings (informational). Under 200 words.

## Aggregation

Collect the four reports and emit a single block:

```
PREFLIGHT REPORT
================
Critical: N
Warning: M

[critical] <file:line> — <one-line description>
[critical] ...
[warning] ...
```

If `Critical > 0`, stop and surface to the user. Don't push.
If only warnings, print them and proceed with `git push -u origin <branch>`.

## Optional hook installation

To run automatically on `git push`, install this as a pre-push hook:

```bash
cat > .git/hooks/pre-push <<'EOF'
#!/bin/sh
claude -p "Run the /preflight skill and exit non-zero if critical findings are reported."
EOF
chmod +x .git/hooks/pre-push
```

(This consumes Claude API credits per push, so it's opt-in.)
