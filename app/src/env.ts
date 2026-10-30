export interface ConfiguredEnv {
  readonly status: 'configured'
  readonly url: string
  readonly anonKey: string
}

export interface NotConfiguredEnv {
  readonly status: 'not-configured'
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

function normalizeUrl(value: string | undefined): string | undefined {
  const trimmed = normalizeValue(value)
  if (!trimmed) {
    return undefined
  }

  // The status check appends its own path, so a trailing slash would produce
  // a double slash in the request URL.
  const withoutTrailingSlashes = trimmed.replace(/\/+$/, '')
  return withoutTrailingSlashes || undefined
}

/**
 * Turns raw Vite environment values into a typed result. A value that is
 * missing, empty, or whitespace-only means the backend is not configured.
 */
export function parseEnvConfig(env: EnvSource): EnvConfig {
  const url = normalizeUrl(env.VITE_SUPABASE_URL)
  const anonKey = normalizeValue(env.VITE_SUPABASE_ANON_KEY)

  if (!url || !anonKey) {
    return { status: 'not-configured' }
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
