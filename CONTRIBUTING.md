# Contributing to OneClickitLeads

This document defines the standard Git and pull request workflow for `oneclickitleads.com`.

## 1. Branching and Setup

Update `main` locally:

```bash
git checkout main
git pull origin main
```

Create a new branch:

```bash
git checkout -b feat/ai-email-extractor
# or
git checkout -b fix/scraping-bug-2026
```

Use branch prefixes:

- `feat/...` for new features
- `fix/...` for bug fixes
- `chore/...` for maintenance

## 2. Making Commits

Stage changes:

```bash
git add .                    # all changes
git add src/lib/ai.ts        # specific file
```

Commit with a clear message:

```bash
git commit -m "feat(ai): add AI Gateway email extractor API"
```

Commit message style:

```text
<type>(<scope>): <short description>
```

- Optional bullets for details
- Keep first line under about 72 chars

Common types:

- `feat`: new feature
- `fix`: bug fix
- `docs`: docs only
- `chore`: dev-tool or infra
- `refactor`: code change with no behavior change

Push your branch:

```bash
git push -u origin feat/ai-email-extractor
```

## 3. Creating a Pull Request (PR)

Go to:

`https://github.com/<your-org>/oneclickitleads-web`

Click "Compare & pull request" from the branch banner, or go to:

`Pull requests -> New pull request`

Set:

- Base: `main`
- Compare: your branch (example: `feat/ai-email-extractor`)

PR title style:

```text
feat(ai): add AI-powered email extractor API
```

Suggested PR body:

```text
## What this PR does

- Adds /api/extract-emails endpoint using Vercel AI Gateway.
- Integrates with existing scraper to clean extracted emails.

## How to test

- Run npm run dev and hit http://localhost:3000/api/extract-emails with sample HTML.
- Check Supabase leads table for new scraped_emails.

## Checklist

- [x] Linting passes
- [x] Environment variables documented
- [x] API key usage explained
```

Also:

- Tag relevant reviewers (frontend, backend, infra)
- Optionally add labels like `feature`, `backend`, `ai`, `scraping`

## 4. During PR Review

Push follow-up commits as needed:

```bash
# make fixes
git add .
git commit -m "fix(ai): validate email types and error handling"
git push
```

GitHub keeps these commits attached to the same PR.

Optional squash flow (only when requested):

```bash
git rebase -i HEAD~3
# mark old commits as squash and keep one clean one
git push --force-with-lease
```

## 5. Merging to Main

Before merge, ensure:

- CI passes (Vercel, tests, lint)
- At least one reviewer approves
- No conflicts with `main`

In GitHub:

- Click "Merge pull request" or "Squash and merge"
- Delete the branch after merge

Then update locally:

```bash
git checkout main
git pull origin main
```

## 6. PR Template

The default template lives at:

`.github/PULL_REQUEST_TEMPLATE.md`

Use it to keep PR descriptions consistent.
