# Tech Stack — Weekly Team Feedback Tool

## Status

Chosen direction for the MVP. This document covers the stack, architecture, security model, data model, and the main implementation decisions. No implementation code yet.

Related: [_docs/plan.md](./plan.md)

---

## 1. Summary

A **React single-page app** backed by **Supabase**, with **Postgres RPCs** as the security boundary and **Supabase Edge Functions** for AI and transcription work.

| Layer | Choice |
|---|---|
| Frontend | Vite + React + TypeScript |
| Routing | React Router |
| Server state | TanStack Query |
| UI | Tailwind CSS + shadcn/ui |
| Drag & drop | dnd-kit |
| Forms & validation | React Hook Form + Zod |
| Database | Supabase Postgres |
| Auth | Supabase Auth (email magic link / Google) |
| File storage | Supabase Storage (signed direct uploads) |
| Realtime | Supabase Realtime (Postgres Changes) |
| Trusted server logic | Postgres RPCs + Supabase Edge Functions |
| AI — clustering & extraction | Claude API (Claude Opus 5.5, structured outputs) |
| AI — transcription | Managed speech-to-text API |
| Background work | Edge Functions + job status table; optional Inngest/Trigger.dev |
| Hosting | Static SPA on Vercel / Netlify / Cloudflare Pages; Supabase Cloud |
| Testing | Vitest, React Testing Library, Playwright, SQL/RLS tests |

**Core principle:** the browser is untrusted. Every privacy rule is enforced in Postgres RLS or inside a `security definer` RPC — never in the UI.

---

## 2. Architecture

```
┌──────────────────────────────────────────────┐
│ React SPA (static hosting)                   │
│ React Router · TanStack Query · dnd-kit      │
└───────────────┬──────────────────────────────┘
                │ Supabase JS client (anon key + JWT)
                ▼
┌──────────────────────────────────────────────┐
│ Supabase                                     │
│  Auth                                        │
│  PostgREST  ── RLS on every table            │
│  RPCs       ── security definer, validated   │
│  Realtime   ── cycles, cards, clusters       │
│  Storage    ── signed uploads                │
└───────────────┬──────────────────────────────┘
                │ service role (server-side only)
                ▼
┌──────────────────────────────────────────────┐
│ Edge Functions                               │
│  cluster-feedback                            │
│  start-transcription                         │
│  transcription-webhook                       │
│  extract-outcomes                            │
│  generate-summary                            │
└───────────────┬──────────────────────────────┘
                │
                ▼
┌───────────────────────┐   ┌──────────────────┐
│ Claude API            │   │ Transcription    │
│ structured outputs    │   │ provider         │
└───────────────────────┘   └──────────────────┘
```

### Request boundaries

- **Normal reads/writes:** browser → Supabase RPC or RLS-protected query.
- **Sensitive reads:** browser → `security definer` RPC only (board view, vote totals).
- **AI and media processing:** browser → Edge Function → provider; provider webhooks back.
- **Large files:** browser uploads directly to Supabase Storage with a signed URL. Files never pass through Edge Functions.

---

## 3. Why this stack

### React SPA instead of Next.js

The product is an authenticated application. SEO and server-side rendering buy almost nothing, while a static SPA is simpler to host, simpler to reason about, and avoids React Server Component complexity.

The trade-off: there are no Next.js API routes/server actions. That role is filled by Supabase RPCs and Edge Functions.

### Supabase directly instead of a separate API

Supabase provides auth, Postgres, storage, realtime, and row-level security in one managed service. For a small-team MVP, a thin separate Node API would add deployment, JWT verification, CORS, and an extra service without enough benefit.

The cost: **RLS and RPC correctness become the most important part of the backend.** They will be tested explicitly.

### Claude Opus 5.5

Used for:

- grouping feedback cards into editable thematic clusters;
- extracting decisions and action items from transcripts, with evidence quotes and timestamps.

Both are structured-output calls. At this product's scale — a few dozen cards and one transcript per week — cost is negligible, so quality wins.

### Managed transcription

Audio/video transcription is delegated to a managed speech-to-text API. Running Whisper locally would add a GPU/CPU worker, deployment, and operational burden not justified for the MVP. A local pipeline remains a possible later optimization.

---

## 4. Security model

### 4.1 Trust boundaries

| Zone | Trust | Holds |
|---|---|---|
| Browser / React SPA | Untrusted | Public `anon` key, user JWT |
| Supabase PostgREST | Enforces RLS | Row-level access |
| Postgres RPCs | Trusted | Privacy and workflow invariants |
| Edge Functions | Trusted | `service_role` key, AI and provider keys |
| Supabase dashboard | Operator | Can read all data — see 4.4 |

### 4.2 Key handling

- The client receives **only** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, and transcription-provider keys exist **only** in Edge Function secrets.
- Anything prefixed `VITE_` is public and must never contain a secret.
- Edge Functions verify the Supabase JWT and re-check project membership/role before privileged work.

### 4.3 Privacy invariants enforced server-side

**Anonymous feedback**

- `cards` contains **no `author_id`**.
- Authorship is stored in a separate `card_authors` table that no client role can read: `anon`, `authenticated`, and `PUBLIC` have no privilege on it, and RLS is enabled with no policies. `cards` is locked down the same way.
- Authors read their own cards through `get_my_cards`, which matches `card_authors.author_id = auth.uid()` inside the function, and write them only through `create_card`, `update_card`, and `delete_card` while the cycle is `collecting`. No card RPC takes a user id or returns an author id, and a card the caller did not write gets the same `card_not_found` error as a card that does not exist.
- The board is loaded through `get_cycle_board`, which returns `is_mine` and, only for attributed cards after reveal, the author's display name. Anonymous cards never join to authorship.
- The facilitator uses the same RPC and cannot retrieve anonymous authors in the product.

**Pre-reveal visibility**

- The reveal happens only through `start_retrospective`, which only the project's current facilitator may call (owning the project gives no right). It moves the open cycle from `collecting` to `reveal` and sets `feedback_cycles.revealed_at` in one update; no card row is copied, changed, or deleted, and no privilege on `cards` or `card_authors` changes.
- "Revealed" means `revealed_at is not null`. A CHECK requires it in `reveal`, `cluster`, `vote`, and `discuss`, and a guard trigger lets it change only once, from null, together with `collecting → reveal`. It is never cleared or moved, and a cycle closed early from `collecting` keeps it null for good.
- Before the retrospective is started, a member receives only their own cards.
- The facilitator also cannot read other members' card content before reveal.
- Project-page "submission status" exposes aggregate counts only, the same for every member including the facilitator; never who submitted, per-member counts, times, or card content; no card total before reveal. It comes from `get_cycle_status`, where "revealed" means `revealed_at is not null` (a cycle closed early from `collecting` is never revealed). The counts are not live: card writes broadcast nothing.
- Residual risk, accepted for the MVP and tracked in #75: after reveal, a fully submitted team where one member has no attributed card shows that member wrote only anonymous cards, and watching the submitted count go up when someone says "done" shows that they submitted.

**Hidden vote totals**

- `votes` rows are readable only by the voter.
- `get_vote_totals` is a `security definer` RPC that returns aggregates only when voting is closed or everyone has voted.
- Realtime is **not** enabled on `votes`.
- A `cycle_events` row broadcasts "voting closed" and stage changes instead.

**Facilitator actions**

- Roles live in `project_members.role`.
- Every facilitator-only RPC checks the caller's membership and role inside the database, not in the client.
- Edge Functions that perform facilitator work repeat the check.

**RPC hardening**

- `security definer` functions validate `auth.uid()` and membership.
- Explicit schema qualification and a fixed `search_path`.
- Execute permission revoked from `public`/`anon`; granted only to `authenticated`.
- No dynamic SQL in RPCs.
- Default-deny RLS on every table; no client access unless explicitly granted.

### 4.4 Anonymity caveat

In-product anonymity is guaranteed: neither the facilitator nor other members can retrieve anonymous authors through the app or API.

**Operator-level anonymity is not guaranteed.** A Supabase project administrator or anyone holding the service-role key can read `card_authors`. This should be stated in the product's privacy documentation.

If operator-level anonymity becomes a requirement, the hardening path is to stop storing the author link for anonymous cards and instead give the contributor a per-card edit token held client-side. That trades editability and recovery for stronger anonymity.

### 4.5 RLS testing

RLS bugs are the highest-risk failure mode of this architecture. Tests will simulate at least:

- member A, member B, facilitator, non-member;
- pre-reveal and post-reveal stages;
- open voting and closed voting;
- anonymous and attributed cards.

Assertions include: A cannot read B's pre-reveal cards; facilitator cannot read authorship; vote totals are unavailable before close; non-members cannot read any cycle data; only the owner can update an action assigned to them.

---

## 5. Data model

Names are indicative; exact columns will be finalized with migrations.

### Identity and projects

| Table | Purpose |
|---|---|
| `profiles` | Display name, avatar, user settings (linked to Supabase Auth) |
| `projects` | Project name, owner, timestamps |
| `project_members` | Project membership and role (`facilitator` / `member`) |

### Feedback cycle

| Table | Purpose |
|---|---|
| `feedback_cycles` | Project, week/title, status, facilitator, reveal/close timestamps |
| `cards` | Cycle, category (`start` / `stop` / `continue`), text, `is_anonymous` |
| `card_authors` | Card → author mapping; self-only RLS; never exposed by the board RPC |
| `clusters` | Cycle, name, sort order, source (`ai` / `manual`), discussion status |
| `cluster_cards` | Cluster membership and ordering; absence means ungrouped |
| `votes` | Cycle, cluster, voter; up to 3 per voter, stackable |
| `notes` | Cycle, optional cluster, author, text, timestamps |
| `cycle_events` | Broadcast events for Realtime: `id`, `cycle_id`, `type` (`stage_changed` for now), `from_status`, `to_status`, `actor_id` (the user who changed the stage, or null), `payload` (`{}`), `created_at`. One row per status change, written only by a trigger on `feedback_cycles`; members of the cycle's project read it, nobody writes or updates it. It never holds card text, card ids, card or submission counts, author ids, per-member data, or vote data |

**Cycle statuses:** `collecting` → `reveal` → `cluster` → `vote` → `discuss` → `closed`.

**Discussion status per cluster:** `pending`, `discussed`, `skipped`, `deferred`.

### Meeting processing

| Table | Purpose |
|---|---|
| `meeting_uploads` | Kind (`audio` / `video` / `transcript_file` / `transcript_text`), storage path or pasted text, processing status, provider job ID |
| `transcripts` | Full text plus timestamped segments |
| `extracted_items` | Draft decisions/actions: description, owner guess, due date guess, evidence quote, timestamp, confidence, status |
| `ai_runs` | Model, prompt version, request ID, token usage, timings — for debugging and cost tracking |

### Outcomes

| Table | Purpose |
|---|---|
| `actions` | Description, owner, optional due date, status (`open` / `done`), related cluster, source extraction |
| `decisions` | Description, related cluster, source extraction |
| `summaries` | Published retrospective snapshot, publisher, timestamp |

A summary is stored as a snapshot so it remains stable even if underlying cards are later edited.

---

## 6. RPC surface

All RPCs validate the caller's membership and the current cycle stage.

### Member RPCs

| RPC | Purpose |
|---|---|
| `get_cycle_board` | Visible cards, clusters, cluster assignments, my votes, `is_mine`, attributed author names after reveal |
| `get_cycle_status` | One row: `cycle_id`, `status`, `is_revealed`, `member_count`, `submitted_member_count`, `my_card_count`, and `card_count` (null before reveal). Aggregate counts only — no ids, names, times, or card content. Voting status is left to #24 |
| `create_card` | Own card during collecting; accepts `is_anonymous` per card |
| `update_card` / `delete_card` | Own card, collecting stage only |
| `create_cluster` / `rename_cluster` | During clustering |
| `move_card` | Move a card between clusters or to ungrouped |
| `merge_clusters` / `split_cluster` | During clustering |
| `cast_vote` / `remove_vote` | Voting stage; enforce max 3 total, stackable |
| `get_vote_totals` | Only after voting closes / everyone has voted |
| `add_note` | Discussion notes |
| `update_action_status` | Owner or facilitator |

### Facilitator RPCs

| RPC | Purpose |
|---|---|
| `create_cycle` / `close_cycle` | Cycle lifecycle |
| `start_retrospective` | collecting → reveal; sets `revealed_at`; facilitator only. Repeating it on a `reveal` cycle is a no-op; any other stage gets `cycle_not_collecting` |
| `advance_stage` | Reveal → cluster → vote → discuss → closed |
| `close_voting` | Ends voting and makes totals visible |
| `set_discussion_status` | Mark cluster discussed / skipped / deferred |
| `create_meeting_upload` | Register upload and issue a signed storage URL |
| `confirm_extracted_items` | Promote draft decisions/actions into confirmed records |
| `publish_summary` | Freeze and publish the retrospective summary |
| `assign_facilitator` | Transfer the facilitator role |

### Edge Functions

| Function | Purpose |
|---|---|
| `cluster-feedback` | Load revealed cards, ask Claude for draft clusters, persist them |
| `start-transcription` | Validate facilitator, submit media to the transcription provider |
| `transcription-webhook` | Verify provider signature, save transcript, trigger extraction |
| `extract-outcomes` | Ask Claude for draft decisions/actions with evidence |
| `generate-summary` | Produce a draft summary from confirmed outcomes and notes |

Every Edge Function verifies the caller or webhook signature and re-checks authorization against the database.

---

## 7. AI pipeline

### 7.1 Clustering

1. Facilitator triggers "Suggest clusters" after reveal.
2. `cluster-feedback` loads all cards and calls Claude with structured output.
3. Output: a list of clusters, each with a short name and card IDs; cards may remain ungrouped.
4. Clusters are stored with `source = 'ai'` as a draft.
5. The team edits freely: move cards, merge, split, rename, ungroup.

Prompt requirements:

- group by underlying theme, not surface wording;
- respect Start / Stop / Continue; do not mix them silently;
- allow an "ungrouped" result;
- keep names short and neutral;
- never finalize — the output is always editable.

Re-running clustering must not destroy manual edits. AI-generated clusters are replaced; manually created/edited clusters are preserved.

### 7.2 Transcription

1. Facilitator uploads audio/video/transcript file, or pastes text.
2. Browser uploads media directly to Supabase Storage via a signed URL.
3. `start-transcription` submits the media (via a short-lived signed URL) to the provider.
4. Provider webhook → `transcription-webhook` saves text and timestamped segments.
5. Pasted text and transcript files skip transcription and go directly to extraction.

### 7.3 Extraction

1. `extract-outcomes` sends the transcript to Claude with structured output.
2. Each extracted decision/action includes description, evidence quote, timestamp, owner guess, due-date guess, and confidence.
3. Results are stored as `draft` in `extracted_items`.
4. The facilitator reviews, edits, accepts, or rejects each item.
5. `confirm_extracted_items` creates confirmed `actions` and `decisions`.

Rules:

- only explicit decisions and commitments are extracted;
- an owner is assigned only when clearly stated;
- a due date is included only when mentioned;
- every item carries evidence for verification;
- nothing is published automatically.

### 7.4 Summary

`generate-summary` assembles top discussion topics, confirmed decisions, confirmed actions, notes, and participation data into a short draft. The facilitator edits and publishes it. The published summary is a snapshot.

---

## 8. Realtime

- **Enabled:** `cycle_events` only, for now. Realtime applies its member-only select policy to each subscriber, and clients listen to `INSERT` only. `clusters` and `cluster_cards` are planned for #17–#19.
- **Not enabled:** `feedback_cycles`, `cards`, `card_authors`, `votes`, `transcripts`, `extracted_items` drafts. Stage changes arrive through `cycle_events` (one `stage_changed` row per status change), not through Realtime on `feedback_cycles`. No client role can read `cards` directly, so card changes reach other sessions through `cycle_events` (#14, #16) rather than through Realtime on `cards`.
- A client that receives an event reads nothing from it and re-reads through the RPCs. It also re-reads every time its channel reports `SUBSCRIBED`, so an event missed while disconnected is caught up.
- Clients use TanStack Query with optimistic updates; Realtime events invalidate the relevant queries.
- A polling fallback (3–5 seconds) is acceptable if Realtime proves unreliable. Realtime is not a hard MVP dependency.

---

## 9. Frontend structure

### Routes

| Route | Screen |
|---|---|
| `/login` | Auth |
| `/projects` | Project list |
| `/projects/:id` | Project page: current cycle, submission status, retrospective, open actions |
| `/cycles/:id/feedback` | Start / Stop / Continue form with per-card anonymity |
| `/cycles/:id/board` | Retrospective board: reveal, cluster, vote, discuss |
| `/cycles/:id/upload` | Meeting upload and processing status |
| `/cycles/:id/summary` | Published retrospective summary |

### Board behavior

- Stage comes from the cycle, not from local UI state.
- Members see facilitator controls only if their role allows them.
- dnd-kit provides drag-and-drop with a keyboard-accessible "move to cluster" fallback.
- Voting UI shows 3 remaining votes, allows stacking, and hides totals until close.
- Discuss mode orders clusters by votes and lets the facilitator mark each topic.

### Client state

- TanStack Query for server state.
- Local component state for ephemeral UI; no global store unless a concrete need appears.
- Zod schemas shared between forms and API responses where practical.

---

## 10. Background processing

`meeting_uploads.status` drives the UI:

`uploaded` → `transcribing` → `extracting` → `draft_ready` → `confirmed` / `published`

Plus `failed` with an error message on each processing step.

For the MVP, Edge Functions plus provider webhooks and a status table are sufficient. Add Inngest or Trigger.dev if retries, multi-step orchestration, or long-running extraction become painful.

Idempotency:

- store provider job IDs;
- make webhook handling safe to retry;
- deduplicate extracted items by upload + evidence;
- use unique constraints where possible.

---

## 11. Testing

| Layer | Tool | Focus |
|---|---|---|
| Unit | Vitest | Vote limits, visibility rules, date parsing, prompt input builders |
| Components | React Testing Library | Feedback form, voting controls, board interactions |
| E2E | Playwright | Full multi-user flow, including anonymity and hidden totals |
| RLS/RPC | pgTAP or a Node test runner using anon-key clients | The privacy invariants in section 4.5 |
| Edge Functions | Deno tests with mocked Claude/provider | Auth checks, webhook signature, schema handling |
| AI quality | Small fixture set of cards and transcripts | Cluster coherence, extraction precision, evidence presence |

The E2E suite must include at least two browser sessions: one member and one facilitator, plus a second member for pre-reveal isolation.

---

## 12. Deployment and operations

### Environments

- **Local:** Supabase CLI, Vite dev server, Edge Functions served locally.
- **Staging:** separate Supabase project and static deployment.
- **Production:** Supabase Cloud and static hosting.

### Migrations and secrets

- All schema and RLS changes live in versioned Supabase migrations.
- Edge Function secrets are set in the Supabase dashboard/CLI; never committed.
- AI and transcription keys are rotated independently of the app.

### CI

- Type check, lint, unit tests, build.
- RLS/RPC tests against a local Supabase instance.
- Playwright smoke tests.
- Deploy SPA on merge to main; apply migrations separately.

### Observability

- Supabase logs for Postgres, Auth, Storage, and Edge Functions.
- Sentry (or similar) for the SPA.
- `ai_runs` records model, prompt version, token usage, latency, and request ID.
- Do not log card text, transcripts, or anonymous authorship.

### Privacy operations

- Private storage buckets; short-lived signed URLs.
- Define media/transcript retention (see open questions).
- Document the operator-level anonymity caveat.

---

## 13. Costs

At MVP scale, the dominant costs are engineering time, not infrastructure:

- Supabase free/pro tier for database, auth, storage, realtime.
- Static hosting free or low cost.
- Claude Opus 5.5 at $4 / $20 per million input/output tokens. A weekly retrospective with dozens of cards and a one-hour transcript is cents per run.
- Managed transcription is priced per minute; a weekly one-hour meeting is a small recurring cost. Verify current provider rates.

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| RLS/RPC bug leaks anonymous authors or vote totals | Default-deny policies, security-definer review, multi-user RLS tests in CI |
| Operator can read anonymous authorship | Document the threat model; token-based unlinkable editing as future hardening |
| Edge Function timeout during media processing | Transcription runs at the provider; webhooks update state; optional durable queue |
| Realtime unreliability | Polling fallback; stage transitions are server-authoritative |
| AI clusters are poor or extraction invents owners/dates | Editable drafts, evidence quotes, confidence, facilitator confirmation |
| Large video uploads | Direct-to-storage signed uploads, size limits, encourage audio/transcript |
| Vendor lock-in | Postgres is portable; SPA is static; Edge Functions are thin and replaceable |
| Prompt regressions | Versioned prompts and a small evaluation fixture set |
| Service-role key exposure | Server-only secrets; never `VITE_`; rotate immediately if leaked |

---

## 15. Decisions made

| Decision | Rationale |
|---|---|
| React SPA (Vite), not Next.js | Authenticated app with no SSR/SEO need; simpler static deployment |
| Supabase direct + RLS/RPC, not a separate API | Fewer moving parts for a solo MVP; privacy enforced in Postgres |
| Sensitive reads through RPCs, not table access | Centralizes anonymity, reveal, and vote-total rules |
| Claude Opus 5.5 with structured outputs | Best quality for clustering/extraction; cost negligible at this scale |
| Managed transcription | Avoids operating local Whisper/GPU infrastructure |
| No Realtime on votes | Prevents accidental tally leakage |
| Draft-until-confirmed AI output | Matches the product decision in the plan |
| Published summary is a snapshot | Preserves the historical record |

### Alternatives considered

- **Next.js full-stack + Supabase:** workable, but adds framework-specific server machinery without an SSR benefit.
- **React SPA + thin Hono/Fastify API:** stronger centralized enforcement, but more services and code; revisit if privacy logic outgrows RPCs.
- **Python FastAPI split stack:** best local-AI flexibility, but more infrastructure than the MVP needs.
- **Django/Rails + HTMX:** simplest server-rendered model, but a weaker fit for the interactive board and the chosen React preference.
- **Firebase/Firestore:** realtime is easy, but the relational shape and privacy rules are a poor fit.

---

## 16. Open questions

1. **Ungrouped cards and voting.** The plan ranks clusters by votes but allows cards to remain ungrouped. Are ungrouped cards votable via an implicit "Ungrouped" bucket, or excluded from voting?
2. **Attendance.** Is attendance entered manually by the facilitator, or derived from submissions/votes?
3. **Invitations.** Slack/email integrations are out of scope. Is an invite link/code sufficient, or should Supabase Auth send email invites?
4. **Multiple facilitators.** One facilitator per project, or can several members hold the role?
5. **Cluster editing rights.** The plan says "the team" can move/merge/split. Confirm that all members, not just the facilitator, get these RPCs.
6. **Post-reveal card editing.** Cards are editable before the retrospective. Should they become read-only after reveal? (Recommended: yes.)
7. **Notes visibility.** Are discussion notes visible to the whole team, or only the facilitator?
8. **Media retention.** Delete uploaded audio/video after transcription, or retain for re-processing? For how long?
9. **Upload limits.** Maximum file size and accepted formats.
10. **Transcription languages.** Which languages must the provider support at launch?
11. **Summary versioning.** Does an edited/published summary need revision history, or is a single published snapshot enough?

---

## 17. Explicitly out of scope for the MVP

Carried over from the product plan, plus stack-level deferrals:

- Built-in meeting recording, Zoom/Meet/Teams integrations.
- Slack/email integrations and automated reminders.
- Advanced project management (priorities, subtasks, dependencies, recurring actions).
- Sentiment or performance scoring, cross-project analytics.
- Custom retrospective frameworks.
- Real-time collaborative transcript editing.
- Multiple approval workflows.
- Local Whisper/GPU transcription pipeline.
- Embedding-based clustering.
- A separate Node API unless RPC complexity justifies it.
- Mobile apps, SSO, audit-log UI, data-retention automation.
