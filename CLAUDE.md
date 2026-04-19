# CLAUDE.md

## Project Stack

- **Framework:** Next.js ^15.1.0 (App Router, `reactStrictMode: true`)
- **Language:** TypeScript 5.x — strict mode, `moduleResolution: bundler`, path alias `@/*`
- **Styling:** Tailwind CSS 3.x + PostCSS
- **Auth / DB:** Supabase (`@supabase/ssr`, `@supabase/supabase-js`)
- **Forms:** react-hook-form + zod
- **Payments:** Stripe
- **Package manager:** npm
- **Node target:** ES2022
- **Linter:** ESLint 9 flat config (`eslint.config.mjs`) — `eslint-config-next` core-web-vitals + typescript presets
  - Run with: `npm run lint` (invokes `eslint .` directly, not `next lint`)
  - Never use legacy `.eslintrc` format
- **Build:** `npm run build` (Next.js)
- **Dev server:** `npm run dev`

## PR Workflow

- Always develop on a feature branch — never commit directly to `main`
- Branch naming pattern: `<type>/<short-description>` (e.g., `chore/eslint-flat-config`)
- Open PRs as **draft** initially; mark ready for review only after CI passes
- PR description must include:
  - Summary bullet points (what changed and why)
  - Test plan checklist
- Bundle related config + dependency changes in a single atomic PR
- After pushing, always verify CI check status before reporting completion
