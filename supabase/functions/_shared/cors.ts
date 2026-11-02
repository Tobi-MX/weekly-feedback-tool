/**
 * CORS for the Edge Functions. The allowed origin comes from the
 * ALLOWED_ORIGIN secret per environment (#43); locally it defaults to the
 * Vite dev server.
 */

export const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:5173'

export const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type'

/** The configured origin, or the local default when unset or blank. */
export function allowedOrigin(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? DEFAULT_ALLOWED_ORIGIN : trimmed
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}
