/**
 * Every setting of the cluster-feedback function. The model and its settings
 * have no environment override: changing them is a code change (#45 tunes
 * them).
 */

export const FUNCTION_NAME = 'cluster-feedback'

/** `_docs/tech-stack.md` §1, §3, §15. */
export const CLUSTER_MODEL = 'claude-opus-5-5'

/** Claude Opus 5.5's default, set explicitly. */
export const CLUSTER_EFFORT = 'medium'

export const CLUSTER_MAX_TOKENS = 16000

/** Server-side refusal fallback, routed by refusal category. */
export const CLUSTER_FALLBACKS = 'default'
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** SDK client options: one retry, so a run stays under the 150 s wall clock. */
export const ANTHROPIC_TIMEOUT_MS = 60_000
export const ANTHROPIC_MAX_RETRIES = 1

/** Request body limit in bytes. */
export const MAX_BODY_BYTES = 1024

/** Fewer available cards than this make no model call. */
export const MIN_CARDS_FOR_MODEL = 2

/** Every error the function returns, with its HTTP status and fixed message. */
export const ERRORS = {
  method_not_allowed: { status: 405, message: 'Only POST requests are allowed.' },
  invalid_request: {
    status: 400,
    message: 'The request body must be a JSON object with a cycle_id UUID.',
  },
  not_authenticated: { status: 401, message: 'Sign in to suggest clusters.' },
  not_project_member: { status: 403, message: 'You are not a member of this project.' },
  not_project_facilitator: {
    status: 403,
    message: 'Only the facilitator can suggest clusters.',
  },
  cycle_not_clustering: {
    status: 409,
    message: 'Clusters can be suggested only in the cluster stage.',
  },
  ai_run_in_progress: {
    status: 409,
    message: 'Suggestions are already being generated for this cycle.',
  },
  clusters_changed_during_run: {
    status: 409,
    message: 'The board changed while suggestions were being generated. Try again.',
  },
  cluster_limit_reached: {
    status: 409,
    message: 'This cycle already has the maximum number of clusters.',
  },
  too_many_cards: {
    status: 413,
    message: 'This cycle has too many cards to suggest clusters for.',
  },
  ai_run_limit_reached: {
    status: 429,
    message: 'The limit of suggestion runs for this cycle has been reached.',
  },
  ai_refused: { status: 502, message: 'The AI declined to suggest clusters for these cards.' },
  ai_invalid_output: {
    status: 502,
    message: 'The AI returned suggestions that could not be used.',
  },
  ai_unavailable: { status: 503, message: 'The AI service is unavailable. Try again later.' },
  ai_timeout: { status: 504, message: 'The AI service took too long to respond. Try again.' },
  ai_not_configured: { status: 500, message: 'AI suggestions are not configured on this server.' },
  internal_error: { status: 500, message: 'Something went wrong. Try again.' },
} as const

export type ErrorCode = keyof typeof ERRORS

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERRORS, value)
}
