/**
 * Caller authentication for the Edge Functions. The bearer token is checked
 * for shape and expiry locally, then verified by Supabase Auth through an
 * injected verifier. Nothing here logs or returns the token.
 */

/** Verifies a Supabase access token. */
export interface AuthVerifier {
  /**
   * The user id the token belongs to, or null when Auth rejects the token.
   * Throws only when Auth itself cannot be reached.
   */
  getUserId(jwt: string): Promise<string | null>
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/

function decodeBase64Url(segment: string): string | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * The JWT from an `Authorization: Bearer <jwt>` header, or null when the
 * header is missing, is not three base64url segments, has a payload that is
 * not a JSON object, or has an `exp` claim at or before `nowMs`.
 */
export function bearerToken(header: string | null, nowMs: number): string | null {
  if (header === null) {
    return null
  }
  const match = BEARER.exec(header)
  if (match === null) {
    return null
  }
  const payloadText = decodeBase64Url(match[2])
  if (payloadText === null) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(payloadText)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const exp: unknown = (payload as Record<string, unknown>).exp
  if (exp !== undefined && (typeof exp !== 'number' || exp * 1000 <= nowMs)) {
    return null
  }
  return `${match[1]}.${match[2]}.${match[3]}`
}
