# Testing

How the test suites are organized and how to run and extend the multi-user
RLS suite.

## Test layers

| Layer         | Command                         | What it proves                                                                                            |
| ------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Unit          | `cd app && npm test`            | Components, hooks, and API wrappers with mocked Supabase. Needs no stack.                                 |
| pgTAP         | `supabase test db`              | Schema, grants, policies, and RPCs inside Postgres, per migration.                                        |
| Anon-key RLS  | `cd app && npm run test:rls`    | Multi-user privacy rules through real signed-in anon-key clients, the same path the browser uses.         |

The RLS suite lives in `app/tests/rls/` and is configured by
`app/vitest.rls.config.ts`. It runs in Node, loads none of the unit-test setup
(`src/setupTests.ts`) or mocks (`src/test/*Mock`), and `npm test` excludes it.

## Prerequisites

- Docker running.
- The Supabase CLI (the version in [local-development.md](local-development.md)).
- `supabase start` from the repo root.
- `supabase db reset` after migrations change, so the stack matches
  `supabase/migrations/`.

If the stack is not running, `npm run test:rls` fails within seconds with one
message telling you to run `supabase start`; no test runs.

## Keys

Before any test runs, `tests/rls/globalSetup.ts` reads `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from the environment. When
any of them is missing it runs `supabase status -o env` at the repo root and
maps `API_URL`, `ANON_KEY`, and `SERVICE_ROLE_KEY`. Values already in the
environment win.

- The suite refuses any `SUPABASE_URL` whose hostname is not `127.0.0.1`,
  `localhost`, or `::1`, before sending a request. It never runs against
  staging or production.
- The harness never reads `VITE_*` variables or `app/.env.local`, and the
  service-role key is never put in either. Anything prefixed `VITE_` ships to
  the browser.
- No key value, password, or session token is printed.
- Only `tests/rls/admin.ts` creates the service-role client, and only
  `fixtures.ts` and `globalSetup.ts` import it. Test files never do.

CI uses no repository secrets: the `Database (local Supabase)` job runs
`supabase start` and the suite reads the stack's local default keys.

## Sign-in method and rate limits

`createUser(label)` creates a confirmed user through the admin API with an
admin-set random password, then calls `signInWithPassword` on the user's own
anon-key client. No email is sent (Mailpit stays empty), and the password
never leaves `createUser`. Every client is created with
`persistSession: false`, `autoRefreshToken: false`, and
`detectSessionInUrl: false`, so no two users share a session.

A run signs in about twenty users. `supabase/config.toml` raises
`[auth.rate_limit] sign_in_sign_ups` and `token_verifications` to `300` per
five minutes for this suite; `email_sent` stays `2`. After changing them, run
`supabase stop && supabase start`. A sign-in rejected with HTTP 429 fails the
run with a message naming that setting. It is never retried.

## Fixture and assertion API

`tests/rls/fixtures.ts`:

| Export                                   | What it does                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createUser(label)`                      | Confirmed user `rls-<runId>-<label>@example.test`, display name `<label>`; returns `{ id, email, label, client }`. Labels must be unique per run. |
| `anonClient()`                           | An anon-key client with no session.                                                              |
| `createRoleCast(prefix)`                 | `{ owner, memberA, memberB, nonMember }`, created with `createUser`. Call it in `beforeAll`.      |
| `createProject(owner, name?)`            | Inserts through the owner's client with `.from('projects')`. The owner is its facilitator.       |
| `createInvite(project, owner)`           | Calls `create_project_invite` (creates or rotates) and returns the token.                        |
| `addMember(project, owner, user)`        | `create_project_invite` as the owner, then `join_project` as the user.                           |
| `makeFacilitator(project, owner, user)`  | Calls `transfer_facilitator` as the owner.                                                       |
| `projectWithRoles(cast)`                 | A new project with member A and B joined; returns `{ project, owner, memberA, memberB, nonMember }`. |
| `joinWithToken(user, token)`             | Calls `join_project` and returns the raw result.                                                 |
| `getMembers(user, projectId)`            | Calls `get_project_members` and returns the raw result.                                          |
| `expireInvite(projectId)`                | Service role: moves `project_invites.expires_at` into the past (no product RPC exists yet).      |
| `unknownId()`                            | A random UUID that names no row.                                                                 |

It also exports hand-written row types (`ProjectRow`, `ProfileRow`,
`ProjectMemberRow`, `MemberRpcRow`, `InviteRpcRow`, `JoinRpcRow`).

`tests/rls/assertions.ts` checks both `data` and `error` every time:

- `expectRows(result, n)`: no error and exactly `n` rows. Returns the rows.
- `expectNoRows(result)`: no error and `data` is `[]` — RLS filtered the rows.
- `expectPgError(result, code, message?)`: `data` is null and `error.code` is
  `code` (and `error.message` is exactly `message` when given) — a grant,
  policy check, or RPC denied the call.

Rules for cases:

- Every allow and deny assertion runs through a user client or
  `anonClient()`, never the service role.
- To check that an update or delete filtered by RLS affected nothing, add
  `.select()` to the write, assert `expectNoRows`, then read the row back
  through a client allowed to read it.
- Create users in `beforeAll` and projects inside each test. Do not depend on
  another test's data or on the seed user `dev@example.com`. The suite must
  pass with `npm run test:rls -- --sequence.shuffle`.
- Use one `describe` per domain and name each test after the actor and the
  allowed or forbidden action.

### Add a privacy case

Add a file such as `app/tests/rls/cycles.test.ts`. It is picked up without
editing the config or the helpers.

```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { expectNoRows, expectRows } from './assertions'
import {
  createRoleCast,
  projectWithRoles,
  type ProjectRow,
  type RoleCast,
} from './fixtures'

describe('cycles', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('cycles')
  })

  it('non-member cannot rename a project', async () => {
    const { project, owner, nonMember } = await projectWithRoles(cast)

    expectNoRows(
      await nonMember.client
        .from('projects')
        .update({ name: 'Taken over' })
        .eq('id', project.id)
        .select(),
    )

    const [row] = expectRows<ProjectRow>(
      await owner.client.from('projects').select().eq('id', project.id),
      1,
    )
    expect(row.name).toBe(project.name)
  })
})
```

## Cleanup

- Teardown (in `globalSetup`) runs after every file, also when tests fail. It
  deletes every project owned by a user from this run, then those auth users.
  The order is required because `projects.owner_id` is `on delete restrict`;
  member and invite rows go with the projects through their cascades.
- At startup, `globalSetup` sweeps leftovers from interrupted runs (for
  example after Ctrl-C): every auth user whose email matches
  `rls-%@example.test`, and the projects they own.
- After a run, `select count(*) from auth.users where email like
  'rls-%@example.test'` returns `0`, and the seed user is unchanged.

**Only one suite may run against a given stack at a time.** The startup sweep
removes another concurrent run's users and makes it fail.

## A failing privacy assertion is a product bug

Never weaken RLS, a grant, or an RPC check to make an RLS test pass, and never
loosen an assertion to match current behaviour. Fix the product, or file a bug
against the task that owns the rule.
