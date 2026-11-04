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
| Drag & drop | Native HTML5 drag on fine pointers plus a per-card "Move" menu (Radix dropdown); no library (#18) |
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
│ React Router · TanStack Query · native DnD   │
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
- The board is loaded through `get_cycle_board`, which shows only the caller's own cards until `revealed_at` is set and every card after. Attributed cards carry the author's display name and `is_mine`. Anonymous cards carry neither and are identical for every caller.
- Card timestamps and creation order are visible only to the author; the board returns no timestamps and orders cards by category, then random card id.
- The facilitator uses the same RPC and cannot retrieve anonymous authors in the product.
- Clusters (#17) live in `clusters` and `cluster_cards`, which are default-deny like `cards` (RLS with no policies, no client privilege). The six RPCs `create_cluster`, `rename_cluster`, `delete_cluster`, `move_card`, `merge_clusters`, and `split_cluster` are the only write path, and only the project's current facilitator may call them successfully (#19b): everyone else, the owner included when not the facilitator, gets `not_project_facilitator`. Neither table has a creator, editor, or actor column. `get_cycle_board` returns them as one `clusters` key, `[]` before reveal and the same for every caller after; anonymous cards gain no key.
- `cycle_events` also carries `clusters_changed` (#17): one row per changed cycle for every statement that changes `clusters` or `cluster_cards`, written by statement-level triggers. A CHECK requires `actor_id` null, `payload = '{}'`, and `from_status = to_status`, so who edited a cluster is never broadcast and an edit can never be tied to a card author.

**AI clustering (#20)**

- Card text, anonymous card text included, is sent to Anthropic when the facilitator asks for suggestions (§7.1). That is the only data sent: each available card's text and category under a short per-request reference (`c1`, `c2`, …), in category, then card-id order, the names of the team's manual clusters, and the number of cluster slots left.
- Never sent: card UUIDs, `is_anonymous`, author ids, display names, `is_mine`, timestamps, creation order, and project, cycle, member, or user data. Anonymous and attributed cards are sent the same way, so nothing tells them apart. Text can still contain whatever the author typed.
- `cluster-feedback` reads cards only through `begin_ai_clustering`, which never reads `card_authors` or `profiles`. The reference-to-card map stays in the function's memory for the request and is never logged or stored.
- `ai_runs` holds no card text, prompt, model output, cluster name, card id, author, or user id, and no client role can read it. The function's log line holds codes, ids of the run and cycle, timings, token counts, and the model only.
- Model output is untrusted: it is validated in the function and again inside `replace_ai_clusters`, and the worst result of a prompt injection is a bad grouping or name in an editable draft.

**Pre-reveal visibility**

- The reveal happens only through `start_retrospective`, which only the project's current facilitator may call (owning the project gives no right). It moves the open cycle from `collecting` to `reveal` and sets `feedback_cycles.revealed_at` in one update; no card row is copied, changed, or deleted, and no privilege on `cards` or `card_authors` changes.
- "Revealed" means `revealed_at is not null`. A CHECK requires it in `reveal`, `cluster`, `vote`, and `discuss`, and a guard trigger lets it change only once, from null, together with `collecting → reveal`. It is never cleared or moved, and a cycle closed early from `collecting` keeps it null for good.
- Before the retrospective is started, a member receives only their own cards.
- The facilitator also cannot read other members' card content before reveal.
- Project-page "submission status" exposes aggregate counts only, the same for every member including the facilitator; never who submitted, per-member counts, times, or card content; no card total before reveal. It comes from `get_cycle_status`, where "revealed" means `revealed_at is not null` (a cycle closed early from `collecting` is never revealed). The counts are not live: card writes broadcast nothing.
- Residual risk, accepted for the MVP and tracked in #75: after reveal, a fully submitted team where one member has no attributed card shows that member wrote only anonymous cards, and watching the submitted count go up when someone says "done" shows that they submitted.

**Hidden vote totals**

- `votes` is default-deny (#22): RLS is enabled with no policy, `anon` and `authenticated` hold no privilege, and only `service_role` keeps `select, insert, update, delete`. It is not in `supabase_realtime` and no view reads it. Votes are written only through `cast_vote` / `remove_vote`, and a member reads only their own votes, through `get_cycle_board`'s `my_votes` and `votes_remaining`.
- `get_vote_totals` is a `security definer` RPC that returns aggregates only when `voting_closed_at is not null` **and** the status is `discuss` or `closed`, the same for every caller, the facilitator included. There is no "everyone has voted" gate: it would show totals while the stage is still `vote`, and a member could then move votes. "Results appear when everyone has voted" is reached through #24's auto-close, which sets `voting_closed_at`. A cycle closed from `vote` with `close_cycle` keeps `voting_closed_at` null and never shows totals.
- Closing voting (#24) moves the cycle `vote → discuss` and sets `voting_closed_at` once, in one transaction under the cycle row lock, in one of two ways. **Automatic:** `cast_vote`'s last step calls `private.close_voting_if_complete`, which closes exactly when every current `project_members` row of the project holds exactly 3 votes in the cycle (a member who joined during `vote` counts; votes with a null voter or of a former member count for nobody). It takes no lock of its own and raises nothing; `remove_vote` never closes, and a cycle with zero clusters or a member who never votes waits for the facilitator. **Manual:** the facilitator's `close_voting`, with #16's lock order; on a cycle already in `discuss` it is a successful no-op (a second click, a second tab, or a lost race with an automatic close). The rule comes only from `project_members` and `votes` inside the database, never from a client signal.
- One close, one event: there is **no `voting_closed` event type**. #14's trigger records the single `stage_changed` `vote → discuss` row, and neither path inserts into `cycle_events`. That row has `actor_id` null whichever path closed voting, so the event never says who cast the last vote or whether the close was automatic.
- `voting_closed_at` invariants: a CHECK keeps it null in `collecting`, `reveal`, `cluster`, and `vote`, and set in `discuss` (`closed` may have it or not). A guard trigger (after #10's guard) lets it change only from null to a value together with `vote → discuss`; clearing or moving it raises `cycle_immutable_column`.
- Votes outlive their voter: `voter_id` is `on delete set null`, so a deleted account's votes still count in totals but belong to nobody's budget. A removed member's votes (#49) stay and count.
- No broadcast and no side effects: a vote write inserts into or deletes from `votes` and nothing else. It changes no `feedback_cycles`, `project_members`, `clusters`, or `cluster_cards` row (their `updated_at` included) and records no `cycle_events` row. The voter's own board refetch is the only signal.
- Residual risks, accepted: a vote write can wait milliseconds on the cycle row lock while another member's write holds it, which reveals at most that someone wrote at the same moment, never what they voted for. After close, totals are aggregates; in a 2-member team either member can subtract their own votes to work out the other's (inherent to showing totals; the plan rejected permanently private votes).

**Discussion notes (#25)**

- Notes are attributed and visible to the whole team: every member of the project sees every note of the cycle with its author's current display name. There is no anonymous note and no facilitator-only note; anonymity is offered for feedback cards only, and a note is part of the meeting record. Every note form says "Notes show your name to the whole team."
- Who: any current member adds notes (the facilitator and the owner included); only a note's author edits it; the author or the project's **current** facilitator deletes it (the facilitator's only moderation power); only the current facilitator sets a discussion status. The owner gets nothing extra unless they are the facilitator.
- When: every write (`set_discussion_status`, `add_note`, `update_note`, `delete_note`) works only while the cycle is in `discuss`; `get_cycle_discussion` answers members in every stage, so the summary (#34) can read a closed cycle. Before `discuss` every status is `pending` and there are no notes. A guard trigger lets `clusters.discussion_status` change only in `discuss`, so the column means the same everywhere.
- `notes` is default-deny like `cards`, `clusters`, and `votes`: RLS enabled with no policy, no privilege for `PUBLIC`, `anon`, or `authenticated`, only `service_role` keeps `select, insert, update, delete`; it is not in `supabase_realtime` and no view reads it. The five RPCs are the only path, and the author is never taken from the client: it is always `(select auth.uid())` inside the RPC. No discussion RPC takes or returns a user id; two members' reads differ only in `is_mine`.
- Notes outlive their author's account: `author_id` is `on delete set null`, such a note shows "Deleted account" and can still be deleted by the facilitator. A member removed from the project (#49) keeps their name on their notes.
- Note writes broadcast `notes_changed` (no actor, payload `{}`, no id, text, name, or count); notes are attributed, so their timing reveals nothing hidden.

**Action items (#26)**

- "Owner" is the action's owner: the member it is assigned to (`actions.owner_id`). The project owner gets nothing extra unless they are the facilitator.
- Who: any current member adds an action and assigns it to any current member (themselves and the facilitator included). Its creator (`created_by`) or the **current** facilitator edits its description, owner, due date and related topic, and deletes it. Its owner or the current facilitator marks it done or reopens it; the creator cannot, unless also the owner or the facilitator. Everyone else reads every action.
- When: `create_action`, `update_action` and `delete_action` work only in `discuss`; `set_action_status` works in `discuss` and `closed`, because actions are followed up after the meeting (#27); `get_cycle_actions` answers members in every stage. Editing and reassigning after `closed` is #112. Deleting is allowed in `discuss` only, with an inline confirmation; there is no delete or archive afterwards.
- Owners must be current members when assigned: the RPCs check `p_owner_id` against `project_members` on create and whenever the owner changes; an unchanged owner is not re-checked. `owner_id` and `created_by` are `on delete set null`: a deleted account's action stays, shows "Deleted account" as owner, and only the facilitator can change its status.
- `actions` is default-deny like `cards`, `clusters`, `votes`, and `notes`: RLS enabled with no policy, no privilege for `PUBLIC`, `anon`, or `authenticated`, only `service_role` keeps `select, insert, update, delete`; it is not in `supabase_realtime` and no view reads it. The four write RPCs and `get_cycle_actions` are the only path, and the creator is never taken from the client: it is always `(select auth.uid())` inside the RPC. `p_owner_id` is only ever the assignee. `get_cycle_actions` returns no `created_by` id; two members' reads differ only in `owner_is_me` and `created_by_me`.
- Action writes broadcast `actions_changed` (no actor, payload `{}`, no id, text, name, or count); actions are attributed, so their timing reveals nothing hidden.

**Facilitator actions**

- Roles live in `project_members.role`.
- Every facilitator-only RPC checks the caller's membership and role inside the database, not in the client.
- Edge Functions that perform facilitator work repeat the check.

**RPC hardening**

- `security definer` functions validate `auth.uid()` and membership.
- Explicit schema qualification and a fixed `search_path`.
- Execute permission revoked from `public`/`anon`; granted only to `authenticated`. The three AI clustering RPCs (#20) are the exception: they are granted only to `service_role`, take the user id the Edge Function verified from the JWT, and check membership and role for that id.
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

Assertions include: A cannot read B's pre-reveal cards; facilitator cannot read authorship; vote totals are unavailable before close; non-members cannot read any cycle data; only the action's owner or the facilitator can change its status; only its creator or the facilitator can edit or delete it.

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
| `feedback_cycles` | Project, week/title, status, facilitator, reveal/close timestamps. `voting_closed_at` (#24) is null in `collecting` through `vote` and set in `discuss` (CHECK; `closed` may have it or not), and a guard trigger lets it change only from null to a value with `vote → discuss`, never cleared or moved (`cycle_immutable_column`) |
| `cards` | Cycle, category (`start` / `stop` / `continue`), text, `is_anonymous` |
| `card_authors` | Card → author mapping; self-only RLS; never exposed by the board RPC |
| `clusters` | `id`, `cycle_id`, `name` (trimmed, 1–100 characters, no control characters, unique per cycle ignoring case), `source` (`manual` / `ai`), `sort_order` (unique per cycle; new clusters are appended), `created_at`, `updated_at` (for operators only, never returned). No creator or editor column. At most 50 per cycle. `discussion_status` (#25): `text not null default 'pending'`, one of `pending`, `discussed`, `skipped`, `deferred` (CHECK `clusters_discussion_status_check`); the guard trigger `clusters_guard_discussion_status` raises `cycle_not_discussing` when it changes outside `discuss`, and fires on no other column. Read only through `get_cycle_discussion`, never through `get_cycle_board` |
| `cluster_cards` | `cycle_id`, `cluster_id`, `card_id` (primary key: a card is in at most one cluster), `sort_order`. Composite foreign keys keep a card in a cluster of its own cycle; deleting a cluster or a card removes its rows. Absence means ungrouped. No actor column |
| `votes` | `id`, `cycle_id` (references `feedback_cycles`, on delete cascade), `cluster_id` (with `cycle_id`, references `clusters (id, cycle_id)`, on delete cascade, so a vote only points at a cluster of its own cycle), `voter_id` (references `auth.users`, on delete set null; never null when written), `created_at` (for operators only, never returned). One row per vote; up to 3 per voter per cycle, stackable. Indexed on `(cycle_id, voter_id)` and `cluster_id`. Default-deny (#22) |
| `notes` | `id`, `cycle_id` (references `feedback_cycles`, on delete cascade), `cluster_id` (null for a general note; with `cycle_id`, references `clusters (id, cycle_id)`, on delete cascade, so a topic note only points at a cluster of its own cycle), `author_id` (references `auth.users`, on delete set null; never null when written), `text` (trimmed with the card trim set, 1–2000 characters, inner line breaks kept), `created_at`, `edited_at` (null until `update_note` first changes the text). Indexed on `(cycle_id, created_at)` and `cluster_id`. The guard `notes_guard_update` keeps `id`, `cycle_id`, `cluster_id`, and `created_at` immutable and lets `author_id` change only to null. At most 500 per cycle. Default-deny (#25) |
| `cycle_events` | Broadcast events for Realtime: `id`, `cycle_id`, `type` (`stage_changed`, `clusters_changed`, `notes_changed`, or `actions_changed`), `from_status`, `to_status`, `actor_id`, `payload` (`{}`), `created_at`. `stage_changed`: one row per status change, written by a trigger on `feedback_cycles`, with `actor_id` the user who changed the stage (or null), except `vote → discuss`, which always has `actor_id` null (#24: the automatic close runs in the last voter's transaction). `clusters_changed` (#17): one row per changed cycle for each statement on `clusters` or `cluster_cards`, written by triggers on those tables, with `from_status = to_status` = the current status and `actor_id` always null. `notes_changed` (#25): the same rule (enforced by `cycle_events_notes_changed_check`) for each statement on `notes`. `actions_changed` (#26): the same rule (enforced by `cycle_events_actions_changed_check`) for each statement on `actions`, `closed` included for a status change after the cycle closed. Only triggers write it; members of the cycle's project read it, nobody updates it. It never holds card text, card ids, cluster ids or names, counts, author ids, per-member data, or vote data |

**Cycle statuses:** `collecting` → `reveal` → `cluster` → `vote` → `discuss` → `closed`.

**Discussion status per cluster:** `pending`, `discussed`, `skipped`, `deferred`.

### Meeting processing

| Table | Purpose |
|---|---|
| `meeting_uploads` | Kind (`audio` / `video` / `transcript_file` / `transcript_text`), storage path or pasted text, processing status, provider job ID |
| `transcripts` | Full text plus timestamped segments |
| `extracted_items` | Draft decisions/actions: description, owner guess, due date guess, evidence quote, timestamp, confidence, status |
| `ai_runs` | One row per AI run (#20): `id`, `cycle_id` (cascade), `function_name` (`cluster-feedback`; #32 and #35 extend the CHECK), `model` (requested), `response_model` (the model that answered, a fallback model after a refusal), `prompt_version`, `status` (`running`, `succeeded`, `failed`, `skipped`), `error_code`, `provider_called`, `provider_request_id`, `provider_status`, `input_tokens`, `output_tokens`, `duration_ms`, `card_count`, `cluster_count`, `started_at`, `finished_at`. At most one `running` row per cycle and function (partial unique index). Server-only: RLS with no policy, only `service_role` may select, insert, and update, not in Realtime. No card text, prompt, output, name, card id, author, or user id. The run's cluster-state fingerprint is kept beside it in `private.ai_run_fingerprints` while it runs |

### Outcomes

| Table | Purpose |
|---|---|
| `actions` | (#26) `id uuid` pk; `cycle_id uuid not null` → `feedback_cycles` `on delete cascade`; `cluster_id uuid` (null = no related topic), with `(cluster_id, cycle_id)` → `clusters (id, cycle_id)` `on delete set null (cluster_id)`, so a topic is always a cluster of the same cycle; `description text not null`, CHECK `description = btrim(description, E' \t\n\r')` and 1–500 characters; `owner_id uuid` → `auth.users` `on delete set null` (never null when written); `due_date date`, CHECK null or 2000-01-01 … 2099-12-31; `status text not null default 'open'`, CHECK `open` / `done`; `completed_at timestamptz`, CHECK `(status = 'done') = (completed_at is not null)`; `source text not null default 'manual'`, CHECK `manual` / `extraction`; `created_by uuid` → `auth.users` `on delete set null` (never null when written); `created_at`, `updated_at timestamptz not null default now()`. Indexes on `(cycle_id, created_at)`, `owner_id`, `cluster_id`. The guard `actions_guard_update` raises `action_immutable_column` when `id`, `cycle_id`, `source`, or `created_at` changes, or `created_by` changes to anything but null. Default-deny (§4.3); at most 200 per cycle |
| `decisions` | Description, related cluster, source extraction |
| `summaries` | Published retrospective snapshot, publisher, timestamp |

A summary is stored as a snapshot so it remains stable even if underlying cards are later edited.

---

## 6. RPC surface

All RPCs validate the caller's membership and the current cycle stage.

### Member RPCs

| RPC | Purpose |
|---|---|
| `get_cycle_board` | Cards visible to the caller (own before reveal, all after), attributed author names, `is_mine` on attributed cards; `clusters` (#17): `[]` before reveal, then every cluster by `sort_order` with exactly `cluster_id`, `name`, `source`, `card_ids` (by `cluster_cards.sort_order`, then `card_id`), the same for every caller; `my_votes` (#22): the caller's own votes, one element per cluster with exactly `cluster_id` and `vote_count` (1–3) by cluster `sort_order`, `[]` when none; `votes_remaining` (#22): 3 minus the caller's votes (0–3). Both read only the caller's rows; never vote totals |
| `get_cycle_status` | One row: `cycle_id`, `status`, `is_revealed`, `member_count`, `submitted_member_count`, `my_card_count`, and `card_count` (null before reveal). Aggregate counts only — no ids, names, times, or card content. Voting status is left to #106 |
| `create_card` | Own card during collecting; accepts `is_anonymous` per card |
| `update_card` / `delete_card` | Own card, collecting stage only |
| `cast_vote` / `remove_vote` | `(p_cycle_id uuid, p_cluster_id uuid)` returns `(cluster_id, vote_count, votes_remaining)`: the caller's own count on that cluster and remaining votes. Any member, the facilitator and owner with the same 3 votes; `vote` stage only; any cluster of the cycle (`manual` or `ai`, with or without cards). Lock the cycle row `FOR UPDATE` (only that lock) before the status check and any use of `votes`, so the cap holds under races and votes serialize with stage changes. Errors: `not_project_member` (null user, unknown cycle, non-member), `cycle_not_voting`, `cluster_not_found`, then `no_votes_remaining` (cast) or `no_vote_to_remove` (remove, which deletes exactly one row). No event, no side effect |
| `get_vote_totals` | `(p_cycle_id uuid)` returns `(cluster_id, total_votes)`: one row per cluster, zeros included, by `total_votes` desc, then `sort_order`, then `cluster_id`. Errors: `not_project_member`, then `voting_not_closed` unless `voting_closed_at` is set and the status is `discuss` or `closed` (set only by #24's close, never because everyone has voted). Aggregates only, the same for every caller |
| `add_note` | `(p_cycle_id uuid, p_cluster_id uuid, p_text text)` returns `(note_id, cluster_id)` (#25). Any member; `p_cluster_id` null is a general note. Locks only the cycle row `FOR UPDATE`, so adds serialize and the 500-note cap holds. Errors in order: `not_project_member` (42501; null user, null or unknown cycle, non-member), `cycle_not_discussing`, `cluster_not_found` (not a cluster of this cycle), `invalid_note_text` (trimmed text null, empty, or over 2000 characters), `note_limit_reached`. The author is `(select auth.uid())` |
| `update_note` | `(p_note_id uuid, p_text text)` returns `(note_id)` (#25). The note's author only. Locks only the cycle row `FOR UPDATE`, then re-reads the note. Errors: `not_project_member` (null user), `note_not_found` (null or unknown note, or a non-member; again if deleted meanwhile), `cycle_not_discussing`, `not_note_author` (42501; the facilitator included, and an orphaned note), `invalid_note_text`. The same trimmed text is a no-op (no `edited_at`, no event); otherwise it sets the text and `edited_at` |
| `delete_note` | `(p_note_id uuid)` returns `(note_id)` (#25). The author or the current facilitator. Locks the `projects` row `FOR SHARE`, then the cycle row `FOR UPDATE`, then re-reads the note. Errors: `not_project_member` (null user), `note_not_found` (also for a non-member, and for the loser of two deletes), `cycle_not_discussing`, `not_note_author` (42501) |
| `get_cycle_discussion` | `(p_cycle_id uuid)` returns `jsonb` with exactly `cycle_id`, `statuses` (one per cluster by `sort_order`, each `cluster_id`, `discussion_status`), and `notes` (by `created_at`, then `note_id`, each `note_id`, `cluster_id`, `text`, `author_name` (current display name, null for a deleted account), `is_mine`, `created_at`, `edited_at`) (#25). Any member, every stage; takes no lock. Error: `not_project_member`. Never reads votes, cards, card authors, or events, and returns no user id |
| `create_action` | `(p_cycle_id uuid, p_description text, p_owner_id uuid, p_due_date date, p_cluster_id uuid)` returns `(action_id)` (#26). Any member; `p_due_date` and `p_cluster_id` may be null. Locks only the cycle row `FOR UPDATE`, so creates serialize and the 200-action cap holds. Errors in order: `not_project_member` (42501; null user, null or unknown cycle, non-member), `cycle_not_discussing`, `cluster_not_found` (not a cluster of this cycle), `invalid_action_description` (trimmed text null, empty, or over 500 characters), `invalid_action_owner` (null, unknown, or not a current member), `invalid_due_date` (outside 2000–2099), `action_limit_reached`. Inserts `open`, `manual`, with the creator `(select auth.uid())` |
| `update_action` | `(p_action_id uuid, p_description text, p_owner_id uuid, p_due_date date, p_cluster_id uuid)` returns `(action_id)` (#26). The creator or the current facilitator; replaces all four fields (a null date or topic clears it). Locks the `projects` row `FOR SHARE`, then the cycle row `FOR UPDATE`, then re-reads the action; `discuss` only. Errors: `not_project_member` (null user), `action_not_found` (null or unknown action, or a non-member; again if deleted meanwhile), `cycle_not_discussing`, `not_action_editor` (42501; the owner and the project owner included), then `cluster_not_found`, `invalid_action_description`, `invalid_due_date`, and `invalid_action_owner` (null, or changed to a non-member; an unchanged owner is not re-checked). Equal values are a no-op (no `updated_at`, no event). Never changes `status`, `completed_at`, `source`, `cycle_id`, or `created_by` |
| `set_action_status` | `(p_action_id uuid, p_status text)` returns `(action_id, status)` (#26; replaces the planned `update_action_status`). The action's owner or the current facilitator; the creator gets nothing of their own. Same locks as `update_action`; `discuss` or `closed`. Errors: `not_project_member`, `action_not_found`, `cycle_not_discussing` (any other stage), `action_not_found` (deleted meanwhile), `not_action_owner` (42501), `invalid_action_status` (not `open` / `done`). The same status is a no-op; otherwise it sets `status`, `completed_at` (`now()` for `done`, null for `open`), and `updated_at` |
| `delete_action` | `(p_action_id uuid)` returns `(action_id)` (#26). The creator or the current facilitator. Same locks as `update_action`; `discuss` only. Errors: `not_project_member`, `action_not_found` (also for the loser of two deletes), `cycle_not_discussing`, `not_action_editor` (42501) |
| `get_cycle_actions` | `(p_cycle_id uuid)` returns `jsonb` with exactly `cycle_id` and `actions` (by `created_at`, then `action_id`, each with exactly `action_id`, `cluster_id`, `description`, `owner_id`, `owner_name` (current display name, `Member` if none, null when `owner_id` is null), `owner_is_me`, `created_by_me`, `due_date` (`YYYY-MM-DD` or null), `status`, `completed_at`, `source`, `created_at`, `updated_at`) (#26). Any member, every stage; takes no lock. Error: `not_project_member`. Never reads votes, cards, card authors, notes, or events, and returns no `created_by` id |

### Facilitator RPCs

| RPC | Purpose |
|---|---|
| `create_cycle` / `close_cycle` | Cycle lifecycle |
| `start_retrospective` | collecting → reveal; sets `revealed_at`; facilitator only. Repeating it on a `reveal` cycle is a no-op; any other stage gets `cycle_not_collecting` |
| `advance_stage` | Facilitator only; one step: reveal → cluster, cluster → vote. vote → discuss is `close_voting` (#24); discuss → closed is `publish_summary` (#34). Takes `(p_cycle_id, p_from_status)`: the caller names the stage it leaves, so a repeat is a no-op and nothing skips a stage. Errors: `not_project_member`, `not_project_facilitator`, `invalid_stage_transition`, `stage_out_of_date`. It inserts no event itself; #14's trigger records one `stage_changed` row |
| `create_cluster` / `rename_cluster` / `delete_cluster` | Facilitator only (19b); the owner gets nothing extra. Locks the `projects` row `FOR SHARE`, then the cycle row `FOR UPDATE`; `cluster` stage only. Names are trimmed and must be 1–100 characters on one line and unique in the cycle ignoring case; at most 50 clusters. Renaming flips `source` to `manual`; renaming to the same name is a no-op. Deleting ungroups the cluster's cards. Errors: `not_project_member`, `not_project_facilitator`, `cluster_not_found`, `cycle_not_clustering`, `invalid_cluster_name`, `cluster_name_taken`, `cluster_limit_reached`. They insert no event; #17's triggers record `clusters_changed` |
| `move_card` | Facilitator only (19b); the owner gets nothing extra. Locks the `projects` row `FOR SHARE`, then the cycle row `FOR UPDATE`; `cluster` stage only. Moves any card, attributed or anonymous, into a cluster at a zero-based position (null or too large appends; negative is refused), between clusters, up and down inside one, or to Ungrouped (null cluster, null position). Renumbers every cluster it touched to `sort_order` 0 … n-1 by (`sort_order`, `card_id`), and sets their `source` to `manual`; a move to the current place is a no-op that writes nothing. Ungrouped has no stored order. Errors: `not_project_member` (42501), `not_project_facilitator` (42501), `card_not_found`, `cluster_not_found`, `cycle_not_clustering`, `invalid_card_position`. It inserts no event and records no actor; #17's triggers record `clusters_changed` (#18) |
| `merge_clusters` / `split_cluster` | Facilitator only (19b); the owner gets nothing extra. Locks the `projects` row `FOR SHARE`, then the cycle row `FOR UPDATE`, and both re-read under the lock; `cluster` stage only, on any cluster, manual or AI. Merge (`p_source_cluster_id`, `p_target_cluster_id`) appends the source's cards to the target (target's cards, then the source's, each by `sort_order`, `card_id`, renumbered 0 … n-1), deletes the source, and returns the target, which keeps its id, name, and place. Split (`p_cluster_id`, `p_card_ids`, `p_name`) moves the selected cards, in their order in the cluster, to a new `manual` cluster appended last under #17's name rules and 50-cluster limit, renumbers both sides, and returns the new cluster; at least one card must move and one stay. Every cluster whose cards change becomes `manual`; a merge of an empty source leaves the target unchanged. Errors: `not_project_member` (42501), `not_project_facilitator` (42501), `cluster_not_found`, `cycle_not_clustering`, `cannot_merge_into_self`, `invalid_card_selection`, `card_not_in_cluster`, `split_takes_all_cards`, `invalid_cluster_name`, `cluster_name_taken`, `cluster_limit_reached`. Neither inserts an event or records an actor; #17's triggers record `clusters_changed` (#19) |
| `accept_ai_clusters` | Keep (#21). Facilitator only (19b); the owner gets nothing extra. Takes `p_cycle_id`, returns the number of clusters kept. Same lock order as #100: membership check, then the `projects` row `FOR SHARE`, then the facilitator check, then the cycle row `FOR UPDATE`; `cluster` stage only. Sets every `source = 'ai'` cluster of the cycle to `manual` (ids, names, order and cards unchanged); a second call returns 0 and changes nothing. Errors: `not_project_member` (42501, also for an unknown cycle), `not_project_facilitator` (42501), `cycle_not_clustering`. It inserts no event and records no actor; #17's statement trigger records one `clusters_changed` row when a cluster changed, which also makes an in-flight AI run fail with `clusters_changed_during_run` |
| `close_voting` | `(p_cycle_id uuid)` returns `(id, status, voting_closed_at)` (#24). Facilitator only; the owner gets nothing extra. Lock order as `advance_stage`: membership, the `projects` row `FOR SHARE`, the facilitator check, then the cycle row `FOR UPDATE`. In `vote` it sets `discuss` and `voting_closed_at = now()`; in `discuss` it is a no-op that returns the current row with the same `voting_closed_at` (idempotent). Errors: `not_project_member` (42501, also for a null or unknown cycle), `not_project_facilitator` (42501), `stage_out_of_date` (any other status). It never reads votes and inserts no event; #14's trigger records one `stage_changed` row with `actor_id` null. Voting also closes automatically on the vote that gives every member all 3 (§4.3) |
| `set_discussion_status` | `(p_cluster_id uuid, p_status text)` returns `(cluster_id, discussion_status)` (#25). Facilitator only; the owner gets nothing extra. Lock order as #16: membership, the `projects` row `FOR SHARE`, the facilitator check, then the cycle row `FOR UPDATE`; `discuss` only. Errors in order: `not_project_member` (null user), `cluster_not_found` (null or unknown cluster, or a non-member), `not_project_facilitator` (42501), `cycle_not_discussing`, `invalid_discussion_status`. The current value is a no-op (no `updated_at`, no event); a change records one `clusters_changed` row through #17's trigger |
| `create_meeting_upload` | Register upload and issue a signed storage URL |
| `confirm_extracted_items` | Promote draft decisions/actions into confirmed records |
| `publish_summary` | Freeze and publish the retrospective summary |
| `assign_facilitator` | Transfer the facilitator role |

### Service-role RPCs (#20)

Callable by `service_role` only, from the `cluster-feedback` Edge Function after it verified the caller's JWT. Each takes the verified user id and reads `project_members` for it; errors are stable codes with no detail.

| RPC | Purpose |
|---|---|
| `begin_ai_clustering(p_cycle_id, p_user_id, p_model, p_prompt_version)` | Locks `projects` `FOR SHARE`, checks the facilitator, locks the cycle `FOR UPDATE`, `cluster` stage only. Marks a `running` run older than 5 minutes `failed` / `run_abandoned`, then refuses another running run, 20 runs that reached the model, 50 manual clusters, and more than 300 available cards. Inserts the `running` row, stores the cluster fingerprint, and returns exactly `run_id`, `cards` (each `card_id`, `category`, `text`), `manual_cluster_names`, `cluster_slots`. Errors: `not_project_member`, `not_project_facilitator`, `cycle_not_clustering`, `ai_run_in_progress`, `ai_run_limit_reached`, `cluster_limit_reached`, `too_many_cards`, `invalid_ai_payload` |
| `replace_ai_clusters(p_run_id, p_user_id, p_clusters, p_metrics)` | Same locks and checks again, then the stale check: the fingerprint must be unchanged. Re-validates the payload (`{name, category, card_ids}` per cluster), deletes the cycle's `ai` clusters, inserts the new ones with name suffixes, and marks the run `succeeded` (or `skipped`) with its metrics, all in one transaction. Errors: the begin codes above that apply, `clusters_changed_during_run`, `run_not_active`, `invalid_ai_payload` |
| `finish_ai_run(p_run_id, p_status, p_error_code, p_metrics)` | Ends a `running` run without writing clusters (a failure with its error code); locks only the run row. Errors: `run_not_active`, `invalid_ai_payload` |

### Edge Functions

| Function | Purpose |
|---|---|
| `cluster-feedback` | Facilitator only, `cluster` stage only (#20). `POST { cycle_id }` with the user's JWT. Begins a run, sends the available cards to `claude-opus-5-5` with structured outputs, validates the answer, and replaces the cycle's AI clusters through `replace_ai_clusters`, or records the failure with `finish_ai_run`. Returns counts only; the client refetches `get_cycle_board`. Error codes: `_docs/local-development.md` |
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
5. The team edits freely: move cards, merge, split, rename, ungroup. Editing one AI cluster (rename to a different name, a move into, out of or inside it, merge, split) turns it `manual`, which keeps it. **Keep suggestions** (#21, `accept_ai_clusters`) keeps all of them at once: every `ai` cluster of the cycle becomes `manual`, so the badge goes and a rerun no longer replaces them. Keeping is optional; "Start voting" neither needs it nor changes `source`, and voting treats both sources the same.

Prompt requirements:

- group by underlying theme, not surface wording;
- respect Start / Stop / Continue; do not mix them silently;
- allow an "ungrouped" result;
- keep names short and neutral;
- never finalize — the output is always editable.

Re-running clustering must not destroy manual edits. AI-generated clusters are replaced; manually created/edited clusters are preserved.

As built in #20:

- **Who and when.** Only the project's current facilitator, only while the cycle is in `cluster`. Both are checked when the run begins and again when it writes.
- **Available cards.** The cards that are ungrouped or in an `ai` cluster when the run begins. Cards in a `manual` cluster are never sent and never placed. A rerun treats every card that is ungrouped at that moment as available, including one someone deliberately moved to Ungrouped, because #18 leaves no marker; keeping those out of reruns is #97, and #21's regenerate confirmation must say so.
- **The call.** `claude-opus-5-5`, adaptive thinking, `effort: "medium"`, `max_tokens: 16000`, non-streaming, `output_config.format` with the output JSON schema, and the server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) on `client.beta.messages`. The SDK client has a 60 s timeout and one retry. The prompt (`cluster-feedback/v1`) lives in `supabase/functions/cluster-feedback/prompt.ts`; the cards go in the user message as one JSON array, and the system prompt tells the model that card text is data, never instructions.
- **Validation.** `stop_reason` must be `end_turn` (`refusal` is `ai_refused`); the answer must parse and match the schema; every ref must be one that was sent and appear once; every cluster needs a card and one category; names must pass #17's rules; and there may be no more clusters than slots. Anything else is `ai_invalid_output` and writes nothing.
- **Stale check.** No lock is held during the call. The run stores a fingerprint of the cycle's clusters (`id`, `source`) and placements (`card_id`, `cluster_id`); if it differs when the run writes, the write fails with `clusters_changed_during_run`. Any create, delete, move, merge, split, keep, or AI rename during the call makes the run stale; renaming a manual cluster does not.
- **The write.** In one transaction under the cycle lock: delete the cycle's `ai` clusters, insert the new ones as `ai` in the model's order after the remaining clusters, and record the run. A name equal (ignoring case) to a manual cluster's or an earlier new name gets the lowest free suffix ` (2)`, ` (3)`, …, cutting the base so the result stays within 100 characters.
- **Limits.** One running run per cycle (a run older than 5 minutes counts as abandoned), 20 runs per cycle that reached the model, at most 300 available cards, and no run with 50 manual clusters. Fewer than 2 available cards make no call: the run is recorded `skipped` and remaining AI clusters are removed.

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

- **Enabled:** `cycle_events` only. Realtime applies its member-only select policy to each subscriber, and clients listen to `INSERT` only.
- **Not enabled:** `feedback_cycles`, `cards`, `card_authors`, `clusters`, `cluster_cards`, `votes`, `notes`, `actions`, `transcripts`, `extracted_items` drafts. Action writes (#26) reach open boards through `actions_changed` rows, written by statement triggers on `actions` with no actor, payload, id, or text. Note writes (#25) reach open boards through `notes_changed` rows, written by statement triggers on `notes` with no actor, payload, id, or text; status changes reach boards through `clusters_changed`, since a status lives on `clusters`. Cluster changes (#17–#21), card moves (#18) included, reach open boards through `clusters_changed` rows on `cycle_events`, written by triggers on the cluster tables, so the board needs no new channel. Stage changes arrive through `cycle_events` (one `stage_changed` row per status change), not through Realtime on `feedback_cycles`. No client role can read `cards` directly, so card changes reach other sessions through `cycle_events` (#14, #16) rather than through Realtime on `cards`.
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

- Stage comes from the cycle, not from local UI state. The mode, stage indicator, and header badge all come from the latest `get_cycle_board` response (`status`, `is_revealed`); nothing is optimistic. Cards are shown only when `is_revealed` is true, in the response's order (never re-sorted).
- Members see facilitator controls only if their role allows them: the caller's own `get_project_members` row must have `role = 'facilitator'`, never `owner_id`. Loading or failed members show no control.
- Anonymous cards are always labeled "Anonymous" and carry no "you" marker, for their author too. Attributed cards show the author's name, with " (you)" on the caller's own.
- One `cycle_events` channel per open board (#14's `useCycleEvents`). Every event and every `SUBSCRIBED` invalidates the board, cycle, and members queries. The page polls every 4 s only while Realtime is unavailable (`CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`), never while the tab is hidden, and shows a notice. A closed cycle and the not-found state hold no channel and never poll.
- Cluster mode (#17) shows a "New cluster" form, an "Ungrouped (N)" section, and each cluster with Rename and Delete. Since #19b every cluster control (the New cluster form, Rename, Delete, Merge, Split, the Move menus, the split checkboxes, and drag and drop) shows only for the facilitator, from the same `isFacilitator` as the stage control; members, and the owner when not the facilitator, see the same sections, names, counts, and cards read-only, with no control rendered. Losing the role closes every open form, draft, menu, and drag, and moves focus to the mode heading only if it was on a vanished control. A write refused with `not_project_facilitator` toasts "Only the facilitator can change clusters.", hides the controls and the stage control at once, and re-reads the members; the controls follow that answer. Client validation mirrors the server's name rules and also refuses "Ungrouped". A refetch never overwrites a draft; a form whose cluster disappears closes and focus moves to the new-cluster input. "Start voting" shows the cluster and ungrouped-card counts first.
- Card movement (#18) has no library. Every card in cluster mode has a "Move" button and Radix menu (Move up, Move down, Move to Ungrouped, Move to <cluster>), the keyboard, screen-reader, and touch path. On fine pointers (`(pointer: fine)`) cards are also natively draggable; a drag carries only the card id under `application/x-weekly-feedback-card`, and each cluster and Ungrouped is a drop target with a ring and a 2 px insertion line. Touch dragging is #91. One move runs at a time.
- Card moves are the one optimistic board write: the cluster view draws the pending `move_card` variables over the server board (never a cache edit) until the refetch after it is in, and drops the overlay at once on failure. The stage and every other board write stay non-optimistic. After a move, focus goes to the card's Move button only if focus is still on that card or was lost to `<body>`.
- Merge and Split (#19) are inline forms in a cluster's section, never a dialog, sharing #17's single open form, so one rename, delete, merge, or split is open on the board at a time. "Merge" (shown with two or more clusters) opens a "Merge into" native select of the other clusters with a confirmation sentence; "Split" (shown with two or more cards) adds a native checkbox to each of the cluster's cards ("Select card: <text>", no author) and a "New cluster name" form with an "N of M cards selected" count. Both are non-optimistic: the board shows the result after its refetch, the status region announces it, and focus goes to the target's or new cluster's Rename button only if focus was still in the form or on `<body>`. While a merge or split is pending no card moves, and while a move is pending neither sends. Refetches update the options, counts, and selection, never a typed name.
- AI suggestions (#21). In cluster mode the facilitator alone gets an "AI suggestions" panel (members and the non-facilitator owner never render it) between the intro and the New cluster form. Its counts come from the latest board (available = ungrouped or in an `ai` cluster). It offers **Suggest clusters** or, with AI clusters, **Regenerate suggestions**, plus **Keep suggestions**, or a sentence instead of the trigger when there are no cards, fewer than 2 or more than 300 available, 50 manual clusters, or this tab got `ai_run_limit_reached`. Each opens an inline confirmation sharing #17's single open form. The browser sends only `{ cycle_id }` to `cluster-feedback` through `supabase.functions.invoke` (`aiClusteringApi.ts`); any 401 is `not_authenticated`. While a run from this tab is pending, the main button reads "Generating suggestions…" with `aria-disabled`, and every cluster write in this tab (create, rename, delete, merge, split, move, drop) and Keep send nothing, so the facilitator's own edits cannot make the run stale; "Start voting" stays. The run lives in the board page, so its result survives a stage change. Every outcome re-reads the board; success is announced after the refetch, errors show inline as a `role="alert"` (with Try again for retryable codes) or as a toast when the panel is gone. Focus moves after a result only if it was in the panel or on `<body>`. Other tabs and members announce "New AI suggestions are on the board." once when a refetch brings AI cluster ids they had not seen. The copy for every error code lives in one module, `aiClusteringErrors.ts`, a `Record` over the codes. Keep is non-optimistic and awaits the refetch.
- Each `ai` cluster shows a text badge **AI suggestion** inside its `h3`, after the name and count, to every viewer, driven only by `source`; it goes after the refetch that shows `manual`. Merge and Move option labels stay the bare name.
- Vote mode (#23, `VoteMode.tsx`) replaces the placeholder and flat card list in `vote` only. Under the "Vote" `h2` it shows, in order: the intro, the notice "Vote totals are hidden from everyone, the facilitator included, until voting closes.", a plain-text counter ("You have N votes left." / "You have 1 vote left." / "You have used all 3 votes." plus a line on when voting closes), the status region, one section per cluster in the response's order (never by votes), and "Ungrouped (N)" last, only when N > 0, read-only with "Ungrouped cards cannot receive votes.". Each cluster section has cluster mode's `h3` (`ClusterHeading`, with the **AI suggestion** badge), "Your votes: N", **Add vote** and **Remove vote** (named "Add vote to {name}" / "Remove vote from {name}"), and its cards as read-only `ClusterCardItem`s, never a control inside a card. A cluster with the caller's votes also gets a thicker border. With zero clusters it shows "There are no clusters to vote on." instead of the counter and clusters. The facilitator, the owner, and members get the same view; it does not read the role.
- Vote writes (`votesApi.ts`, `useVotes.ts`) call `cast_vote` / `remove_vote` with `(p_cycle_id, p_cluster_id)` and parse exactly one strict `(cluster_id, vote_count, votes_remaining)` row. The own counts and votes left come only from `get_cycle_board`'s `my_votes` / `votes_remaining`. While a write is pending, the view draws it (±1 on that cluster, ∓1 on the counter) over the numbers of the board that was on screen when it was sent, so a refetch that lands meanwhile never counts the vote twice. The query cache is never edited; the write settles only after the board refetch it starts, and a failure drops the overlay at once, toasts, and re-reads the board. One write at a time: while one is pending every vote button sends nothing (a synchronous ref guard covers a double click or held Enter).
- Unavailable vote buttons use `aria-disabled="true"`, never `disabled`, so focus stays on them: Add at 0 left or while a write is pending, Remove at 0 own votes on that cluster or while pending. Pressing Add at 0 left announces "You have no votes left. Remove a vote from another topic to place it here."; an unavailable Remove does nothing. Focus never moves in vote mode.
- Vote mode's status region announces only a settled write, from the RPC's row ("Vote added to {name}. Your votes on it: N. Votes left: M." or "Vote removed from …"). Errors are toasts only; refetches, polls, other tabs, and a write that settles after the stage moved on announce nothing. The error copy lives in `voteErrors.ts`, a `Record` over every code; `not_project_member` shows the not-found state instead. The other copy lives in `VoteMode.tsx`.
- Vote mode never calls `get_vote_totals` and shows no total, rank or participation count. Nothing about other members' votes, and no vote data in Realtime, storage, the URL, or the console.
- Close voting (#24): in `vote` the facilitator alone (from the caller's own members row) gets **Close voting** between the `h2` and vote mode, reusing `AdvanceControl`'s inline confirmation ("Close voting for everyone? …"), focus on Cancel, Escape, the ref guard, "Closing…" while pending, and the toast "Voting closed. The board moved to Discuss."; focus then moves to the Discuss `h2` once the board shows it. `not_project_facilitator` toasts, hides the control at once, and re-reads the members; `stage_out_of_date` and other failures toast; `not_project_member` shows the not-found state.
- Leaving vote mode by any path (own close, another tab, an automatic close, the caller's own last vote) happens when a refetch, event, or poll returns `discuss`, announced as `Stage: Discuss`. Vanished-control rule: if focus was on a vote control that no longer exists (it fell to `<body>`), it moves to the Discuss `h2`; otherwise focus does not move.
- Discuss mode (#24, `DiscussMode.tsx`) shows the ranked agenda, the same DOM for every member, the facilitator and owner included. Under the "Discuss" `h2`: the intro "Voting has closed. Topics are listed by total votes, most votes first."; "No votes were cast. Topics are listed in their cluster-board order." when every total is 0, or else "Topics with the same number of votes are listed in their cluster-board order." when two topics share a total; then an `<ol>` in exactly `get_vote_totals`' order (never re-sorted; `rankedAgenda` in `boardModel.ts` joins the totals to the board's clusters and refuses mismatched ids), each item with cluster mode's `h3` and badge, the total as text ("1 vote" / "N votes"), and its cards read-only; then "Ungrouped (N)" when N > 0 with "Ungrouped cards were not part of the vote.". Zero clusters show "There were no topics to vote on."; loading shows "Loading results…"; a failed or mismatched read shows "Could not load the vote results." with Retry. `get_vote_totals` (`voteTotalsApi.ts`, `useVoteTotals.ts`) is called only while the board shows `discuss` and is re-read on every cycle event.
- The agenda shows aggregates only: no "your votes", per-voter data, percentage, bar, or participation count. `my_votes` stays in the board response but is not rendered, because the agenda is typically shared on screen and own votes would reveal the facilitator's ballot (and make #22's 2-member subtraction effortless).
- Discussion (#25, `DiscussMode.tsx`, `DiscussionStatusControl.tsx`, `TopicNotes.tsx`, `discussionApi.ts`, `useDiscussion.ts`): **statuses never reorder the agenda**; the list stays in `get_vote_totals` order and no topic is hidden, collapsed, or moved by its status. The list renders only when both the totals and `get_cycle_discussion` have loaded (`Loading results…` meanwhile); a failed discussion read or a mismatch (`discussionByTopic` in `boardModel.ts`) shows "Could not load the discussion notes." with Retry, and a totals error takes precedence. The discussion query is enabled only in `discuss`, polls with the board's interval, and is invalidated by `invalidateAll`.
- Each topic keeps #24's `h3`, vote line, and cards, and adds after the vote line `Status: {Label}` for everyone and, for the facilitator only, a group "Discussion status for {name}" with **Pending**, **Discussed**, **Skipped**, **Deferred** (`aria-pressed` on the current one; the status line says the same in text); after the cards a notes block with `Notes (N)`, the notes in server order or "No notes yet.", and **Add note**. **General notes (N)** follows the list (and "There were no topics to vote on." with zero clusters) and precedes Ungrouped. A note shows its text with line breaks kept and a byline: the author name, " (you)", "Deleted account", " (edited)", never a clock time. **Edit** is on the caller's own notes; **Delete** on own notes and, for the facilitator, on every note. Controls are never inside a card.
- Writes are non-optimistic: a status or note change shows after the refetch it starts (no overlay, no cache edit). Add and edit forms are inline (`<textarea>` labelled "Note on {name}", "General note", or "Edit note", the hint, **Save note**, **Cancel**), several at once, each with its own draft that a refetch never overwrites; opening one focuses its textarea; Escape or Cancel discards. Client validation on submit only, no `maxLength`. Delete opens an inline confirmation with focus on Cancel. One status write and one note write at a time (`aria-disabled`, "Saving…" / "Deleting…", a synchronous ref guard). After success the keyed status region announces "{name} marked {Label}.", "Note added to {name}." / "General note added.", "Note updated.", or "Note deleted.", and focus stays on the pressed status, or goes to Add note, the note's Edit, or the topic's Add note. Errors are toasts from `discussionErrors.ts` (a `Record` over every code and write); a failed form keeps its text. A refetch that removes a note whose control held focus moves focus to the topic's Add note ("This note was deleted." when an edit draft was open); losing the facilitator role moves focus to the Discuss `h2` only if it was on a status or moderation control.
- Action items (#26, `ActionItems.tsx`, `ActionForm.tsx`, `actionsApi.ts`, `actionErrors.ts`, `actionModel.ts`, `useActions.ts`): one section with the `h3` **Action items (N)** after General notes and before Ungrouped, also with zero clusters. Its loading (`Loading action items…`) and load error ("Could not load the action items." with Retry, also for an `actionsWithTopics` mismatch) are local to the section; the agenda and notes stay usable. The `get_cycle_actions` query is enabled only in `discuss`, polls with the board's interval, and is invalidated by `invalidateAll`. Items are listed in server (creation) order, a status change never moves one, and each shows its description (line breaks kept), `Owner: {name}` (` (you)`, or `Deleted account`), `Due {Nov 12, 2026}` or `No due date`, `Topic: {name}` or `No related topic`, and `Status: Open` / `Status: Done`.
- **Overdue is a client-only label**: an open action whose `due_date` is before the viewer's local calendar date (`localDateIso`) adds ` · Overdue` as text; a done action and a date of today are never overdue. Dates are formatted from the `YYYY-MM-DD` string in UTC so they never shift a day. A project time zone is #67.
- Controls are never inside a card: **Mark done** / **Reopen** for the action's owner and the facilitator, **Edit** and **Delete** for the creator and the facilitator, and **Add action item** for every member. While the members query is loading or has failed, Add, Edit, and Delete do not render and the toggle shows only on the caller's own actions. The form (`ActionForm.tsx`) is inline, one add and one edit per item at once, each with its own draft: a `Description` textarea (no `maxLength`), an `Owner` native select of the current members from the board's members query (the caller's with ` (you)`), a `Due date (optional)` native date input (2000–2099), a `Related topic` select in agenda order, the hint "Action items show to the whole team.", **Save action**, and **Cancel**. Validation runs on submit with per-field `role="alert"` messages tied by `aria-describedby`. A refetch never overwrites a draft; an owner no longer listed resets to `Choose an owner`.
- Writes are non-optimistic and one at a time (`aria-disabled`, "Saving…" / "Updating…" / "Deleting…", a synchronous ref guard); action writes and note or status writes do not block each other. After the awaited refetch the status region announces "Action item added.", "Action item updated.", "Action item marked done.", "Action item reopened.", or "Action item deleted.", and focus goes to Add action item, the item's Edit, or its toggle. Errors are toasts from `actionErrors.ts`; `not_action_editor` / `not_action_owner` hide the facilitator controls and re-read the members, `invalid_action_owner` re-reads the members. A refetch that removes an action closes its form ("This action item was deleted." when a draft was open) and moves focus to Add action item only if it was on that action; losing the facilitator role moves focus to the Action items `h3` only if it was on a facilitator-only control.

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

1. ~~**Ungrouped cards and voting.**~~ Answered by #22: clusters only. Every cluster of the cycle (`manual` or `ai`, including one with zero cards) can receive votes; ungrouped cards, single cards, and an implicit "Ungrouped" bucket cannot.
2. **Attendance.** Is attendance entered manually by the facilitator, or derived from submissions/votes?
3. **Invitations.** Slack/email integrations are out of scope. Is an invite link/code sufficient, or should Supabase Auth send email invites?
4. **Multiple facilitators.** One facilitator per project, or can several members hold the role?
5. **Cluster editing rights.** The plan said "the team" can move/merge/split. First closed for any-member editing: every current member could create, rename, and delete clusters (#17), move cards (#18), and merge and split clusters (#19), with nothing extra for the facilitator or the owner. Reopened by the project owner, and answered by #19b: only the project's current facilitator may create, rename, delete, move, merge, or split. The owner gets nothing unless they are the facilitator. Members see the board read-only. Closed again.
6. **Post-reveal card editing.** Cards are editable before the retrospective. Should they become read-only after reveal? (Recommended: yes.)
7. ~~**Notes visibility.**~~ Answered by #25: the whole team, attributed. Every member sees every note with its author's name; there are no anonymous or facilitator-only notes.
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
