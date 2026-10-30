# AGENTS.md

## Stack

React + TypeScript SPA (Vite) in `app/`, Supabase for Postgres, Auth, Storage, Realtime, and Edge Functions, and the Claude API for clustering and meeting extraction. See `_docs/tech-stack.md` for the full architecture and `_docs/plan.md` for the product scope.

## Commands

- `cd app && npm install` - install dependencies
- `cd app && npm run dev` - start the Vite dev server
- `cd app && npm test` - the whole unit suite
- `cd app && npm test -- src/App.test.tsx` - one test file
- `cd app && npm run typecheck` - TypeScript check
- `cd app && npm run lint` - lint
- `cd app && npm run build` - production build
- `cd app && npm run test:e2e` - Playwright end-to-end tests
- `supabase start` - start local Supabase
- `supabase db reset` - rebuild the local database from migrations
- `supabase test db` - run the pgTAP database tests
- `supabase functions serve` - run Edge Functions locally

## Rules

- Dependencies are added in `app/package.json`. Do not add one without asking.
- Frontend code lives in `app/`; migrations and Edge Functions live in `supabase/`.
- Use TypeScript strict mode. Avoid `any`; fix the type instead.
- Never expose `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, or transcription-provider keys to the client. Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are public.
- Enforce anonymity, pre-reveal visibility, and hidden vote totals in RLS or `security definer` RPCs, never only in the UI.
- All schema changes go through a Supabase migration. Do not edit the database by hand.
- Every change includes tests and must pass lint, typecheck, and the test suite.
- Keep the MVP scope in `_docs/plan.md`; do not add features from its excluded list.
- AI features use the Claude API with structured outputs. Do not switch providers or models without asking.
- Do not commit secrets. `.env*` (except `.env.example`) and `.claude/settings.local.json` are gitignored.

## Documents

- `_docs/process.md` - how work is organized

