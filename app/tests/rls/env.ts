import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Connection details for the local Supabase stack. The service-role key lives
 * only in the Node test process: it is never logged and never put in a
 * `VITE_` variable. This module never reads `VITE_*` variables or
 * `app/.env.local`.
 */
export interface RlsEnv {
  readonly url: string
  readonly anonKey: string
  readonly serviceRoleKey: string
}

/** Every run's users share this prefix, so the startup sweep can find them. */
export const RLS_EMAIL_PREFIX = 'rls-'
export const RLS_EMAIL_DOMAIN = '@example.test'

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const STATUS_TIMEOUT_MS = 10_000
const HEALTH_TIMEOUT_MS = 5_000

export const NOT_REACHABLE_MESSAGE =
  'Local Supabase is not reachable. Run `supabase start` from the repo root ' +
  '(then `supabase db reset` if migrations changed) and run the suite again.'

export const CLI_MISSING_MESSAGE =
  'The Supabase CLI was not found and SUPABASE_URL, SUPABASE_ANON_KEY, and ' +
  'SUPABASE_SERVICE_ROLE_KEY are not all set. Install the Supabase CLI or ' +
  'export the three variables.'

export const NON_LOCAL_MESSAGE =
  'The RLS suite runs only against local Supabase. SUPABASE_URL must point ' +
  'at 127.0.0.1, localhost, or ::1.'

/**
 * An expected setup failure. Its stack is just the message, so Vitest prints
 * one readable line instead of a stack trace.
 */
export class HarnessSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessSetupError'
    this.stack = `${this.name}: ${message}`
  }
}

/** Throws unless the URL's hostname is the local machine. Sends nothing. */
export function assertLocalUrl(url: string): void {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new HarnessSetupError(NON_LOCAL_MESSAGE)
  }
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new HarnessSetupError(NON_LOCAL_MESSAGE)
  }
}

/** Parses `supabase status -o env` output (`KEY="value"` lines). */
export function parseStatusEnv(output: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of output.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!match) {
      continue
    }
    const [, key, raw] = match
    const value =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw
    values.set(key, value)
  }
  return values
}

function readSupabaseStatus(): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    execFile(
      'supabase',
      ['status', '-o', 'env'],
      { cwd: REPO_ROOT, timeout: STATUS_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(
            new HarnessSetupError(
              error.code === 'ENOENT'
                ? CLI_MISSING_MESSAGE
                : NOT_REACHABLE_MESSAGE,
            ),
          )
          return
        }
        resolve(parseStatusEnv(stdout))
      },
    )
  })
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/**
 * Resolves the three values. Variables already in the environment win; any
 * missing one comes from `supabase status -o env` run at the repo root. A
 * non-local `SUPABASE_URL` is refused before anything else happens.
 */
export async function resolveEnv(
  source: NodeJS.ProcessEnv = process.env,
): Promise<RlsEnv> {
  let url = nonEmpty(source.SUPABASE_URL)
  let anonKey = nonEmpty(source.SUPABASE_ANON_KEY)
  let serviceRoleKey = nonEmpty(source.SUPABASE_SERVICE_ROLE_KEY)

  if (url !== undefined) {
    assertLocalUrl(url)
  }

  if (
    url === undefined ||
    anonKey === undefined ||
    serviceRoleKey === undefined
  ) {
    const status = await readSupabaseStatus()
    url ??= nonEmpty(status.get('API_URL'))
    anonKey ??= nonEmpty(status.get('ANON_KEY'))
    serviceRoleKey ??= nonEmpty(status.get('SERVICE_ROLE_KEY'))
  }

  if (
    url === undefined ||
    anonKey === undefined ||
    serviceRoleKey === undefined
  ) {
    throw new HarnessSetupError(NOT_REACHABLE_MESSAGE)
  }

  assertLocalUrl(url)
  return { url: url.replace(/\/+$/, ''), anonKey, serviceRoleKey }
}

/** Fails fast with one message when the local API does not answer. */
export async function assertReachable(env: RlsEnv): Promise<void> {
  try {
    const response = await fetch(`${env.url}/auth/v1/health`, {
      headers: { apikey: env.anonKey },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error('unhealthy')
    }
  } catch {
    throw new HarnessSetupError(NOT_REACHABLE_MESSAGE)
  }
}
