# Weekly Feedback Tool — Task Backlog

## How to use this backlog

This backlog implements the MVP described in [_docs/plan.md](./plan.md) using the stack in [_docs/tech-stack.md](./tech-stack.md). Tasks are ordered by dependency; a task can be handed to someone who has not read the others as long as they read the two docs above and the task's stated prerequisites.

Conventions:

- Frontend lives in `app/`; Supabase migrations and Edge Functions live in `supabase/`.
- Every task includes its own tests and must leave typecheck, lint, and the existing test suite green.
- Privacy-sensitive tasks must extend the multi-user RLS/RPC suite.
- "Session" means one focused working block, not a fixed number of hours.

Milestones:

- **Foundations:** tasks 1–6
- **Projects and cycles:** tasks 7–10
- **Feedback collection:** tasks 11–14
- **Retrospective board:** tasks 15–27
- **Meeting processing and summary:** tasks 28–37
- **Hardening and delivery:** tasks 38–45

---

# Phase 0 — Foundations

## 1. Scaffold the empty React project with a passing test

Goal: A clean React + TypeScript app that installs, builds, and runs a green test.

Description: Create a Vite + React + TypeScript app under `app/` with a minimal App component and Vitest + React Testing Library. Add `dev`, `build`, `test`, and `typecheck` scripts, and confirm that a fresh `npm install` followed by `npm test` passes. Do not add product features or backend code yet.

## 2. Add linting, formatting, and CI

Goal: Every push is type-checked, linted, formatted, and tested automatically.

Description: Configure ESLint, Prettier, and strict TypeScript for the `app/` project, then add a GitHub Actions workflow that runs typecheck, lint, test, and build on every push and pull request. Keep the workflow cached and fast, and make failures easy to read.

## 3. Configure local Supabase and environment files

Goal: A reproducible local backend that the frontend can connect to.

Description: Initialize `supabase/` with the Supabase CLI, local Postgres/Auth/Storage, and committed config. Add a `.env.example` containing only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, document `supabase start`, `supabase stop`, and reset commands, and wire a small connection check into the app. Service-role and AI keys must never appear in client environment files.

## 4. Create the base schema and profile creation

Goal: Every authenticated user has a profile row, and migrations rebuild cleanly from scratch.

Description: Add migrations for `profiles`, enable RLS with self-read and self-update policies, and add a trigger that creates a profile on auth signup. Verify that `supabase db reset` rebuilds the schema from scratch and add a local seed user for development.

## 5. Implement authentication and protected routing

Goal: Users can sign in and out, and unauthenticated visitors cannot reach app pages.

Description: Add Supabase Auth with email magic link and optionally Google, a login screen, session handling, logout, and React Router guards. Handle expired sessions and redirects, and make local magic-link testing work through the local email inbox.

## 6. Build the app shell and navigation

Goal: A consistent responsive layout for projects, cycles, boards, uploads, and summaries.

Description: Add a header, user menu, navigation, page container, toast provider, loading state, and error boundary. Add placeholder routes for the main screens so later tasks can fill them in.

---

# Phase 1 — Projects and cycles

## 7. Create projects and list them

Goal: A signed-in user can create a project and see the projects they own.

Description: Add a `projects` table with an `owner_id` and RLS so owners can read and update their projects, then build a create-project form and project list. The creator becomes the project owner; shared membership and the facilitator role are added in the next task.

## 8. Add project membership, invite links, and facilitator roles

Goal: Project owners can add teammates and transfer the facilitator role.

Description: Add `project_members` with `facilitator` and `member` roles plus invite links that let a signed-in user join a project. Build a members screen to copy the invite link, view members, and transfer the facilitator role, and enforce permissions in RLS/RPCs.

## 9. Build the multi-user RLS test harness

Goal: CI can prove that one user cannot read another user's private data.

Description: Add a test runner that creates multiple local users and uses anon-key clients to exercise RLS and RPCs. Cover profiles, projects, and memberships with member, facilitator, and non-member cases, and structure it so later tasks can add privacy assertions.

## 10. Create weekly feedback cycles

Goal: A facilitator can create a weekly cycle and see its status on the project page.

Description: Add `feedback_cycles` with collecting, reveal, cluster, vote, discuss, and closed statuses, plus facilitator and timestamps, and implement a `create_cycle` RPC. Show the current cycle and past cycles on the project page with dates and status.

---

# Phase 2 — Feedback collection

## 11. Add feedback cards and card RPCs

Goal: Members can create, edit, and delete their own cards during collection.

Description: Add `cards` and `card_authors`, keeping authorship out of the public `cards` row, and implement `create_card`, `update_card`, `delete_card`, and `get_my_cards` RPCs. Enforce own-card access and the collecting stage in the database, and support a per-card anonymous flag.

## 12. Build the feedback form

Goal: Members can submit Start, Stop, and Continue cards with per-card anonymity.

Description: Build the three-section feedback form with add, edit, and delete actions, an anonymous checkbox per card, validation, and unsaved-state handling. Use the card RPCs and show clear empty and submitted states.

## 13. Enforce pre-reveal visibility and submission status

Goal: Members see only their own cards before reveal, while the team sees aggregate submission progress.

Description: Add a `get_cycle_status` RPC returning submission counts without card content, and ensure feedback reads return only the caller's cards before reveal. Add project-page submission progress and RLS tests proving that member A cannot see member B's cards.

## 14. Start the retrospective and reveal all cards

Goal: The facilitator can move a cycle from collecting to reveal in one action.

Description: Add a `start_retrospective` RPC available only to the facilitator that transitions the cycle and reveals every card at once. Record a cycle event for realtime subscribers and prevent new submissions after reveal.

---

# Phase 3 — Retrospective board

## 15. Add the stage-aware board data RPC

Goal: The board can load exactly the cards the current user is allowed to see.

Description: Implement `get_cycle_board` returning visible cards and `is_mine`, with author names only for attributed cards after reveal. Enforce stage rules and membership inside the RPC, and add RLS/RPC tests for pre-reveal, post-reveal, and anonymous cases; cluster data is added in task 17.

## 16. Build the board shell and stage modes

Goal: The board renders Reveal, Cluster, Vote, and Discuss according to the server-side cycle status.

Description: Add the board route and layout with stage indicators, facilitator controls, and the current stage loaded from the cycle. Subscribe to cycle and card changes via Supabase Realtime, with a polling fallback and optimistic query invalidation.

## 17. Add manual cluster creation and renaming

Goal: Team members can group revealed cards into named clusters.

Description: Add `clusters` and `cluster_cards` plus RPCs for creating, renaming, and deleting clusters during the cluster stage, and extend `get_cycle_board` to return clusters and assignments. Build the cluster column UI and keep unassigned cards visible in an ungrouped area.

## 18. Add drag-and-drop card movement

Goal: Cards can be moved into, between, and out of clusters.

Description: Add dnd-kit drag-and-drop with optimistic updates and a `move_card` RPC that persists cluster membership and ordering. Include a keyboard-accessible "move to cluster" fallback and handle concurrent moves gracefully.

## 19. Add cluster merge and split

Goal: The team can merge clusters or split cards out without losing feedback.

Description: Add merge and split RPCs plus UI actions, preserving card order and ungrouped cards. Cover empty clusters, self-merge, and splitting into new clusters with tests.

## 20. Add the AI clustering Edge Function

Goal: The facilitator can generate editable draft clusters from all revealed cards.

Description: Add a `cluster-feedback` Edge Function that calls Claude with a structured-output schema and writes draft clusters with `source = 'ai'`. Configure server-only secrets, validate the response, handle provider failures, and never overwrite manually created clusters.

## 21. Add the AI clustering review flow

Goal: The team can review, accept, or rerun AI clusters without losing manual edits.

Description: Add UI to trigger clustering, show progress and errors, and display draft AI clusters on the board. Support replacing only AI-generated clusters while preserving manual clusters and card moves.

## 22. Implement voting RPCs and hidden totals

Goal: Members can cast three stackable votes without seeing live totals.

Description: Add the `votes` table and RLS so voters can read only their own votes, then implement `cast_vote`, `remove_vote`, and `get_vote_totals` with a three-vote limit. Return aggregates only after the facilitator closes voting or everyone has voted, extend `get_cycle_board` with the caller's votes, and add privacy tests.

## 23. Build the voting UI

Goal: Members can allocate, stack, and remove three votes on clusters.

Description: Add vote controls with a remaining-vote counter, stacked votes, and optimistic updates while keeping totals hidden during voting. Show a "waiting for results" state and prevent voting outside the vote stage.

## 24. Close voting and show the ranked agenda

Goal: Voting ends when everyone has voted or the facilitator closes it, and clusters are ranked by total votes.

Description: Implement automatic close when all project members have voted plus a facilitator `close_voting` RPC, with a cycle event broadcast. Build the results view and order the discuss agenda by vote total with a stable tie-breaker.

## 25. Add discussion statuses and notes

Goal: The facilitator can mark topics discussed, skipped, or deferred, and the team can record notes.

Description: Add a discussion status per cluster and a `notes` table with team-visible RLS, plus RPCs for updating both during the discuss stage. Build the discuss-mode UI with status controls, note entry, and topic ordering from the agenda.

## 26. Add manual action items

Goal: Team members can create and update action items during or after the discussion.

Description: Add the `actions` table with description, owner, optional due date, status, and related topic, plus create and update RPCs. Allow the owner or facilitator to mark an action done and validate due dates and ownership.

## 27. Add the project action list

Goal: The project page shows open and recent action items.

Description: Add queries and UI sections for open and recent actions scoped to the project, including owner, due date, status, and related topic. Include filters, empty states, and permission checks so members only see their own projects.

---

# Phase 4 — Meeting processing and summary

## 28. Add meeting upload registration and signed uploads

Goal: The facilitator can upload audio, video, or a transcript file, or paste transcript text.

Description: Add a `meeting_uploads` table, a private Storage bucket with per-user path policies, and a `create_meeting_upload` RPC that registers the upload and returns its storage path. Build the upload page with type selection, size and format validation, pasted-text input, and processing status placeholders.

## 29. Parse transcript files and pasted text

Goal: Transcript files and pasted text enter the same pipeline as audio and video.

Description: Add a TypeScript parser for plain text, VTT, and SRT that normalizes content into transcript text and timestamped segments, then stores them in `transcripts` via an RPC. Validate size and encoding, and move the upload status directly to extraction-ready.

## 30. Add transcription job orchestration

Goal: Uploaded audio and video are submitted to the transcription provider and tracked.

Description: Add a `start-transcription` Edge Function that validates the facilitator, creates a job with an async provider such as AssemblyAI or Deepgram using a short-lived signed media URL, and stores the provider job ID and status. Put the provider behind a small adapter, mock it in tests, and handle submission failures with retry-safe state.

## 31. Handle transcription webhooks and store transcripts

Goal: Completed transcriptions are saved with timestamps and trigger extraction.

Description: Add a `transcription-webhook` Edge Function that verifies the provider signature, stores transcript text and segments, and transitions the upload idempotently. Reject invalid signatures and duplicate deliveries, and log failures without leaking transcript content.

## 32. Add the extraction Edge Function

Goal: Claude turns a transcript into draft decisions and action items with evidence.

Description: Add an `extract-outcomes` Edge Function using a structured-output schema for decisions, actions, owner guesses, due-date guesses, evidence quotes, timestamps, and confidence. Store results as drafts in `extracted_items`, log each run in `ai_runs`, and never auto-confirm.

## 33. Build the extracted-items review UI

Goal: The facilitator can edit, accept, or reject draft decisions and actions.

Description: Build a review screen grouped by decisions and actions with evidence quotes, timestamps, confidence, and editable owner and due-date fields. Add bulk accept/reject and a confirm RPC that creates the final records.

## 34. Create and publish the retrospective summary

Goal: The facilitator can edit and publish a stable retrospective snapshot.

Description: Add a `summaries` table and draft/publish RPCs, then build the summary editor with sections for top topics, notes, decisions, actions, and participation. Publishing stores an immutable snapshot and makes it visible to project members.

## 35. Generate the AI-drafted retrospective summary

Goal: The facilitator gets a short summary grounded in confirmed outcomes and notes.

Description: Add a `generate-summary` Edge Function that combines top topics, confirmed decisions, confirmed actions, notes, and participation data into a draft stored in the `summaries` table. Keep the output editable and re-runnable, and store generation metadata in `ai_runs`.

## 36. Build the published summary page

Goal: Team members can read a stable retrospective with confirmed outcomes and original cards.

Description: Add a read-only summary route with top topics, key notes, decisions, actions, participation, and original feedback cards. Link actions to their owners and show clear unpublished and empty states.

## 37. Add retrospective history to the project page

Goal: The project page lists completed retrospectives with links to their published summaries.

Description: Add a history section listing completed cycles with dates, status, and summary links, alongside the existing open-action list. Include pagination or a sensible limit and clear empty states.

---

# Phase 5 — Hardening and delivery

## 38. Set up Playwright and multi-user fixtures

Goal: Browser tests can run against local Supabase with isolated users and a clean database.

Description: Add Playwright with scripts that start or connect to local Supabase, seed a project with a facilitator and two members, and mock AI providers. Provide reusable login helpers and a database reset step so tests are deterministic.

## 39. Add the end-to-end happy-path test

Goal: One automated browser test covers the full MVP workflow.

Description: Test creating a project and cycle, submitting cards, revealing, clustering, voting, discussing, uploading a transcript, confirming extracted items, and publishing a summary. Use the seeded multi-user fixtures and mocked AI providers, and run it in CI.

## 40. Add end-to-end privacy tests

Goal: Automated browser tests prove anonymity, pre-reveal isolation, and hidden vote totals.

Description: Add Playwright tests with multiple members and a facilitator that assert member A cannot see member B's pre-reveal cards, anonymous authors never appear, and vote totals stay hidden until close. Include a test that the facilitator cannot retrieve anonymous authorship through the UI.

## 41. Add accessibility and responsive polish

Goal: Core flows work with a keyboard and on small screens.

Description: Audit forms, board drag-and-drop, voting, modals, and navigation for labels, focus order, contrast, and keyboard operation. Fix the issues and verify the main flows at mobile width, including the drag-and-drop fallback.

## 42. Add consistent loading, error, and empty states

Goal: Every async screen gives clear feedback and a recovery path.

Description: Standardize skeleton loaders, error boundaries, retry actions, toasts, and empty states across the project, board, upload, and summary screens. Make failed AI and transcription jobs visible and recoverable.

## 43. Set up staging and production deployment

Goal: The app and backend deploy repeatably to staging and production.

Description: Configure static hosting, separate Supabase projects, environment variables, migrations, Edge Function deployment, and secrets. Document the release process and verify a fresh deployment with a smoke test.

## 44. Write the README and operator runbook

Goal: A new contributor can run, test, and deploy the project without asking questions.

Description: Document local setup, environment variables, Supabase commands, migrations, Edge Functions, test commands, deployment, and the operator-level anonymity caveat. Include troubleshooting notes for auth email, storage, and provider webhooks.

## 45. Add AI evaluation fixtures

Goal: Prompt changes can be checked against a small realistic dataset.

Description: Create fixture sets of feedback cards and transcripts with expected cluster and action outcomes, plus a script that runs the prompts and reports schema validity and quality. Keep it out of the required CI gate until the signal is stable.
