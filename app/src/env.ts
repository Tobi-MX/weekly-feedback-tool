export interface ConfiguredEnv {
  readonly status: 'configured'
  readonly url: string
  readonly anonKey: string
}

export interface NotConfiguredEnv {
  readonly status: 'not-configured'
  /**
   * Set when both values are present but the URL cannot be used. The status
   * indicator reports this as Unreachable instead of pretending the URL points
   * at a backend.
   */
  readonly reason?: 'invalid-url'
}

export type EnvConfig = ConfiguredEnv | NotConfiguredEnv

export interface EnvSource {
  readonly VITE_SUPABASE_URL?: string | undefined
  readonly VITE_SUPABASE_ANON_KEY?: string | undefined
}

function normalizeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function parseSupabaseUrl(value: string): string | undefined {
  // The status check appends its own path, so a trailing slash would produce
  // a double slash in the request URL.
  const withoutTrailingSlashes = value.replace(/\/+$/, '')
  if (!withoutTrailingSlashes) {
    return undefined
  }

  try {
    const parsed = new URL(withoutTrailingSlashes)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined
    }
  } catch {
    return undefined
  }

  return withoutTrailingSlashes
}

/**
 * Turns raw Vite environment values into a typed result.
 *
 * Missing, empty, or whitespace-only values mean the backend is not
 * configured. A non-empty URL that is not an absolute http(s) URL is also
 * reported as not configured, but with an `invalid-url` reason: `fetch` would
 * resolve a relative value against the dev-server origin, whose SPA fallback
 * can answer 200 and make a broken configuration look Connected.
 */
export function parseEnvConfig(env: EnvSource): EnvConfig {
  const rawUrl = normalizeValue(env.VITE_SUPABASE_URL)
  const anonKey = normalizeValue(env.VITE_SUPABASE_ANON_KEY)

  if (!rawUrl || !anonKey) {
    return { status: 'not-configured' }
  }

  const url = parseSupabaseUrl(rawUrl)
  if (!url) {
    return { status: 'not-configured', reason: 'invalid-url' }
  }

  return { status: 'configured', url, anonKey }
}

/**
 * The only place that reads Vite's environment. Both values are public and
 * safe for the browser; secrets must never use a `VITE_` prefix.
 */
export function getEnvConfig(): EnvConfig {
  return parseEnvConfig(import.meta.env)
}
