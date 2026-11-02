import { corsHeaders } from './cors.ts'

/**
 * JSON responses. Every response, errors included, carries the CORS headers
 * and `Content-Type: application/json`.
 */

export function jsonResponse(
  status: number,
  body: unknown,
  origin: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json',
    },
  })
}

/**
 * `{ "error": { "code", "message" } }`. The message is a fixed English
 * sentence; it never carries provider text, card text, ids, names, or a
 * stack.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  origin: string,
): Response {
  return jsonResponse(status, { error: { code, message } }, origin)
}

/** The CORS preflight answer: 204, no body. */
export function preflightResponse(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json',
    },
  })
}
