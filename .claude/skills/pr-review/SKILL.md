---
name: pr-review
description: Respond to GitHub PR review comments — especially Vercel Agent Review bot. Fetches unresolved comments, categorizes actionable vs discussion, implements fixes, verifies build, and replies. Use when a PR has pending review comments or CI/bot failures.
---

# PR Review Response

Use this skill to work through review comments on an open PR without ping-ponging back to the user for each one.

## Inputs

- `pr_number` (required) — e.g. `8`
- Repo is `OneClickIT-ai/oneclickitleads.com` (from CLAUDE.md)

## Steps

### 1. Fetch the current state

Use GitHub MCP tools in parallel:
- `mcp__github__pull_request_read` method `get` → current title, base, head, mergeable_state
- `mcp__github__pull_request_read` method `get_review_comments` → unresolved threads
- `mcp__github__pull_request_read` method `get_check_runs` → CI status
- `mcp__github__pull_request_read` method `get_comments` → bot comments (Vercel, etc.)

### 2. Categorize each comment

For every review comment:
- **Actionable code change** — clear file + line + what to change. Implement it.
- **Discussion / architecturally significant** — stop and ask the user with `AskUserQuestion`. Don't guess.
- **Informational / duplicate** — skip and note why.
- **"DO NOT AUTO-FIX"** in the comment body → skip, flag to user.

### 3. Known Vercel Agent patterns

Match the comment against this cheat sheet before implementing:

| Comment text contains | Fix |
|---|---|
| "module-level" / "Collecting page data" | Wrap SDK init in a lazy `getX()` helper |
| "non-null assertion" / `process.env.X!` | Replace with `const x = process.env.X; if (!x) throw new Error(...)` |
| "arbitrary values" / "enum" | Define `const VALUES = [...] as const`, add `is<T>()` type guard, return 400 listing valid values |
| "missing validation" | Length-cap string inputs (`.slice(0, N)`), `isEmail()` check, honeypot field |

### 4. Apply fixes + verify

- One commit per logical fix. Commit messages: `fix: <short>` with body explaining the review comment being addressed.
- After edits: `npm run build` must pass locally.
- Push to the PR's head branch.

### 5. Reply (sparingly)

- If the fix is obvious from the diff, don't reply — the bot's follow-up review will confirm.
- If the suggestion was incorrect or a variant was preferred, reply with a short explanation via `mcp__github__add_reply_to_pull_request_comment`.

### 6. Close the loop

- Wait for the bot to re-review. If it confirms the fix, resolve the thread with `mcp__github__resolve_review_thread`.
- If new comments appear, repeat from step 1.
- Report final CI status to the user.

## Guardrails

- Max 3 auto-fix attempts per comment. If the third attempt doesn't resolve it, surface to the user.
- Never force-push unless the user asks.
- Never touch `auth/`, `payment/`, or `stripe/` logic without user confirmation beyond lint/type fixes.
