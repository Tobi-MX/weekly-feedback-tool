# Local development

How to run the app against the local Supabase stack.

## Prerequisites

- **Node.js 24.x** — the version used in CI (`.github/workflows/ci.yml` sets
  `node-version: 24` and `app/package.json` pins `@types/node` to 24). Verified
  locally with Node.js 22.22.2 as well.
- **Docker running** — Docker Desktop or another Docker engine. Check with
  `docker info`.
- **Supabase CLI 2.x** — verified with **2.122.0** (`supabase --version`).

## First run

From the repo root:

```bash
cd app && npm install
```

```bash
supabase start
```

The first `supabase start` downloads Docker images and can take several
minutes. When it finishes it prints the local URLs and keys.

```bash
cp app/.env.example app/.env.local
```

```bash
cd app && npm run dev
```

Open <http://localhost:5173>. The page shows a **Local backend** status of
**Connected** once the check against the local Supabase API succeeds.

`app/.env.local` is the only environment file you need. It is gitignored and
must not be committed.

## Environment file

Vite reads `app/.env.local` at dev-server start. The example file
`app/.env.example` is committed and contains exactly two public variables:

| Variable                 | Source in `supabase status -o env` |
| ------------------------ | ---------------------------------- |
| `VITE_SUPABASE_URL`      | `API_URL`                          |
| `VITE_SUPABASE_ANON_KEY` | `ANON_KEY`                         |

Both values belong to the local stack only and are safe to expose in the
browser. Never put the service-role key, the local secret key, the JWT secret,
or any AI or transcription key in a `VITE_` variable (or in
`app/.env.local`): anything prefixed with `VITE_` is shipped to the browser.
Server-only values do not belong in this repository.

If you customize the local JWT secret in `supabase/config.toml`, refresh both
values from `supabase status -o env`. The committed example matches the
default configuration.

Restart `npm run dev` after changing `app/.env.local`.

## Local stack commands

All commands run from the repo root:

```bash
supabase start
```

Starts Postgres, Auth, Storage, Studio, the API, and Mailpit. Requires Docker.

```bash
supabase status
```

Shows the running services, their URLs, and the local keys.

```bash
supabase status -o env
```

Prints the values used by `app/.env.example` (`API_URL`, `ANON_KEY`, and the
server-only keys). Do not copy the server-only values into the app.

```bash
supabase stop
```

Stops the local containers. Local data is preserved.

```bash
supabase db reset
```

Rebuilds the local database from `supabase/migrations/` and then loads
`supabase/seed.sql`. On a fresh project with no migrations and no seed file it
still succeeds and prints `Finished supabase db reset`.

`supabase start` writes local state to `supabase/.temp/` and
`supabase/.branches/`; both are gitignored. The only committed Supabase files
are `supabase/config.toml` and `supabase/.gitignore`.

## Local ports

| Service         | URL / port               |
| --------------- | ------------------------ |
| Supabase API    | <http://127.0.0.1:54321> |
| Postgres        | `127.0.0.1:54322`        |
| Supabase Studio | <http://127.0.0.1:54323> |
| Mailpit         | <http://127.0.0.1:54324> |
| Vite dev server | <http://localhost:5173>  |

## Troubleshooting

### Status shows "Not configured"

The page did not find both public variables, so it did not make a request.

- `app/.env.local` is missing — copy the example:
  `cp app/.env.example app/.env.local`
- `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing, empty, or only
  whitespace. Refill it from `supabase status -o env`.
- The dev server was started before the file was created or edited. Stop it
  and run `cd app && npm run dev` again; Vite reads env files at startup.

### Status shows "Unreachable"

The app could not confirm that the local API is reachable. It shows this state
after a timeout, a network error, or a non-2xx response, and immediately when
`VITE_SUPABASE_URL` is not an absolute `http://` or `https://` URL (in that
case no request is sent).

- `VITE_SUPABASE_URL` is not an absolute `http://` or `https://` URL (for
  example `not a valid url` or `/rest/v1`). The app rejects this value without
  sending a request. Copy `API_URL` from `supabase status -o env` into
  `app/.env.local` and restart the dev server.
- The stack is not running. Check `supabase status`, then run `supabase start`.
- Docker is not running. Start Docker Desktop and confirm `docker info`
  succeeds, then run `supabase start`.
- The URL or anon key is wrong. Re-copy `API_URL` and `ANON_KEY` from
  `supabase status -o env` into `app/.env.local` and restart the dev server.
- A port conflict prevents the API from starting. Another Supabase project or
  process may already use 54321. Stop the other stack with `supabase stop`,
  inspect the port (for example `ss -ltnp | grep 54321`), and run
  `supabase start` again.
- The browser or an extension blocks the request (CORS, VPN, proxy). Open the
  browser devtools Network tab, use <http://127.0.0.1:54321> rather than a
  hostname, and try disabling the extension or proxy for localhost.

The status check runs once on page load and again only when you press
**Retry**. It aborts after 5 seconds and never polls.
