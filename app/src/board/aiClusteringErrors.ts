import {
  FACILITATOR_ONLY_MESSAGE,
  NOT_CLUSTERING_MESSAGE,
} from './clusterErrors'

/**
 * The codes the `cluster-feedback` Edge Function returns (#20), each with its
 * HTTP status. A code is kept only if it is one of these.
 */
export const AI_FUNCTION_ERRORS = {
  method_not_allowed: 405,
  invalid_request: 400,
  not_authenticated: 401,
  not_project_member: 403,
  not_project_facilitator: 403,
  cycle_not_clustering: 409,
  ai_run_in_progress: 409,
  clusters_changed_during_run: 409,
  cluster_limit_reached: 409,
  too_many_cards: 413,
  ai_run_limit_reached: 429,
  ai_refused: 502,
  ai_invalid_output: 502,
  ai_unavailable: 503,
  ai_timeout: 504,
  ai_not_configured: 500,
  internal_error: 500,
} as const satisfies Record<string, number>

export type AiFunctionErrorCode = keyof typeof AI_FUNCTION_ERRORS

/** Every outcome of a failed request: #20's codes and two of the client's. */
export type AiClusteringErrorCode =
  AiFunctionErrorCode | 'network_error' | 'unknown'

export function isAiFunctionErrorCode(
  value: string,
): value is AiFunctionErrorCode {
  return Object.prototype.hasOwnProperty.call(AI_FUNCTION_ERRORS, value)
}

/**
 * Where an error shows: inline in the panel (a `role="alert"` paragraph), as
 * a toast, or as the board's not-found state.
 */
export type AiErrorShownAs = 'inline' | 'toast' | 'not-found'

export interface AiErrorPresentation {
  /** The copy, or null for the not-found state, which has its own. */
  readonly copy: string | null
  readonly shownAs: AiErrorShownAs
  /** Whether the panel offers Try again, which resends with no confirmation. */
  readonly retry: boolean
}

const TRY_AGAIN = 'Could not generate suggestions. Try again.'

export const AI_LIMIT_MESSAGE =
  'This cycle has used all 20 AI suggestion runs. You can still change the clusters yourself.'
export const AI_CLUSTER_LIMIT_MESSAGE =
  'This cycle already has 50 clusters, so there is no room for suggestions.'
export const AI_NOT_CLUSTERING_MESSAGE =
  'The suggestions were not added because the cycle has left the Cluster stage.'

/**
 * The copy for every code. A `Record`, so a missing code fails typecheck.
 * The server's own `message` is never shown, logged, or kept.
 */
export const AI_CLUSTERING_ERRORS: Record<
  AiClusteringErrorCode,
  AiErrorPresentation
> = {
  method_not_allowed: { copy: TRY_AGAIN, shownAs: 'inline', retry: true },
  invalid_request: { copy: TRY_AGAIN, shownAs: 'inline', retry: true },
  not_authenticated: {
    copy: 'Your session has expired. Sign in again to suggest clusters.',
    shownAs: 'inline',
    retry: false,
  },
  not_project_member: { copy: null, shownAs: 'not-found', retry: false },
  not_project_facilitator: {
    copy: FACILITATOR_ONLY_MESSAGE,
    shownAs: 'toast',
    retry: false,
  },
  cycle_not_clustering: {
    copy: AI_NOT_CLUSTERING_MESSAGE,
    shownAs: 'toast',
    retry: false,
  },
  ai_run_in_progress: {
    copy: "Suggestions are already being generated for this cycle, perhaps in another tab. They will appear on the board when ready. If they don't, try again in 5 minutes.",
    shownAs: 'inline',
    retry: true,
  },
  clusters_changed_during_run: {
    copy: 'The board changed while suggestions were being generated. Try again.',
    shownAs: 'inline',
    retry: true,
  },
  cluster_limit_reached: {
    copy: AI_CLUSTER_LIMIT_MESSAGE,
    shownAs: 'inline',
    retry: false,
  },
  too_many_cards: {
    copy: 'There are too many cards for AI suggestions. They work with up to 300 cards that are not in clusters you made or changed.',
    shownAs: 'inline',
    retry: false,
  },
  ai_run_limit_reached: {
    copy: AI_LIMIT_MESSAGE,
    shownAs: 'inline',
    retry: false,
  },
  ai_refused: {
    copy: 'The AI could not suggest clusters for these cards. You can still group them yourself.',
    shownAs: 'inline',
    retry: false,
  },
  ai_invalid_output: {
    copy: 'The AI returned suggestions that could not be used. Try again.',
    shownAs: 'inline',
    retry: true,
  },
  ai_unavailable: {
    copy: 'The AI service is busy or unavailable. Try again in a minute.',
    shownAs: 'inline',
    retry: true,
  },
  ai_timeout: {
    copy: 'The AI took too long to answer. Try again.',
    shownAs: 'inline',
    retry: true,
  },
  ai_not_configured: {
    copy: 'AI suggestions are not set up for this app yet. You can still group the cards yourself.',
    shownAs: 'inline',
    retry: false,
  },
  internal_error: { copy: TRY_AGAIN, shownAs: 'inline', retry: true },
  network_error: {
    copy: 'The connection was lost while suggestions were being generated. If they were added, they will appear when the board reconnects. Otherwise, try again.',
    shownAs: 'inline',
    retry: true,
  },
  unknown: { copy: TRY_AGAIN, shownAs: 'inline', retry: true },
}

/** A failed request, carrying only its stable code. */
export class AiClusteringError extends Error {
  readonly code: AiClusteringErrorCode

  constructor(code: AiClusteringErrorCode) {
    super(code)
    this.name = 'AiClusteringError'
    this.code = code
  }
}

export function aiClusteringErrorCodeOf(error: unknown): AiClusteringErrorCode {
  return error instanceof AiClusteringError ? error.code : 'unknown'
}

/** The codes `accept_ai_clusters` raises that the board handles. */
export const KEEP_ERROR_CODES = [
  'not_project_member',
  'not_project_facilitator',
  'cycle_not_clustering',
] as const

export type KeepErrorCode = (typeof KEEP_ERROR_CODES)[number] | 'unknown'

export const KEEP_FAILED_MESSAGE = 'Could not keep the suggestions.'

/**
 * The toast for a failed keep, or null for `not_project_member`, which
 * switches the board to its not-found state instead.
 */
export function keepErrorMessage(code: KeepErrorCode): string | null {
  switch (code) {
    case 'not_project_member':
      return null
    case 'not_project_facilitator':
      return FACILITATOR_ONLY_MESSAGE
    case 'cycle_not_clustering':
      return NOT_CLUSTERING_MESSAGE
    case 'unknown':
      return KEEP_FAILED_MESSAGE
  }
}

/** A failed keep, carrying only its stable code. */
export class KeepAiClustersError extends Error {
  readonly code: KeepErrorCode

  constructor(code: KeepErrorCode) {
    super(code)
    this.name = 'KeepAiClustersError'
    this.code = code
  }
}

export function toKeepErrorCode(
  message: string | null | undefined,
): KeepErrorCode {
  return KEEP_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

export function keepErrorCodeOf(error: unknown): KeepErrorCode {
  return error instanceof KeepAiClustersError ? error.code : 'unknown'
}
