export const DEFAULT_REDIRECT_PATH = '/projects'

const FORBIDDEN_PATHS = new Set(['/login', '/auth/callback'])

/**
 * Validates a decoded `redirectTo` value before it is used in a navigation or
 * in the magic-link email.
 *
 * Only internal paths that begin with a single `/` and resolve to the app's
 * own origin are accepted. The fragment is dropped and the query string is
 * preserved. Everything else falls back to `/projects`.
 */
export function safeRedirectPath(
  value: string | null | undefined,
  origin?: string,
): string {
  if (value === null || value === undefined) {
    return DEFAULT_REDIRECT_PATH
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return DEFAULT_REDIRECT_PATH
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    return DEFAULT_REDIRECT_PATH
  }

  // Reject protocol-relative and backslash-smuggled URLs before the URL
  // parser can normalize them into an external origin.
  if (!decoded.startsWith('/')) {
    return DEFAULT_REDIRECT_PATH
  }
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) {
    return DEFAULT_REDIRECT_PATH
  }

  const appOrigin = origin ?? window.location.origin

  let resolved: URL
  let appUrl: URL
  try {
    resolved = new URL(decoded, appOrigin)
    appUrl = new URL(appOrigin)
  } catch {
    return DEFAULT_REDIRECT_PATH
  }

  if (resolved.origin !== appUrl.origin) {
    return DEFAULT_REDIRECT_PATH
  }

  if (!resolved.pathname.startsWith('/')) {
    return DEFAULT_REDIRECT_PATH
  }

  // These routes must never be a post-auth destination: `/login` would bounce
  // a signed-in visitor again, and `/auth/callback` would re-enter the
  // credential-consuming route.
  if (FORBIDDEN_PATHS.has(resolved.pathname)) {
    return DEFAULT_REDIRECT_PATH
  }

  return `${resolved.pathname}${resolved.search}`
}

/** Builds `/login?redirectTo=...` with the target encoded exactly once. */
export function buildLoginPath(value: string | null | undefined): string {
  return `/login?redirectTo=${encodeURIComponent(safeRedirectPath(value))}`
}
