import { describe, expect, it } from 'vitest'
import {
  AI_CLUSTERING_ERRORS,
  AI_FUNCTION_ERRORS,
  aiClusteringErrorCodeOf,
  AiClusteringError,
  keepErrorCodeOf,
  keepErrorMessage,
  KeepAiClustersError,
  toKeepErrorCode,
  type AiClusteringErrorCode,
  type AiErrorPresentation,
} from './aiClusteringErrors'

const TRY_AGAIN = 'Could not generate suggestions. Try again.'

/** #21's error table: copy, where it shows, and Try again. */
const TABLE: Record<AiClusteringErrorCode, AiErrorPresentation> = {
  method_not_allowed: { copy: TRY_AGAIN, shownAs: 'inline', retry: true },
  invalid_request: { copy: TRY_AGAIN, shownAs: 'inline', retry: true },
  not_authenticated: {
    copy: 'Your session has expired. Sign in again to suggest clusters.',
    shownAs: 'inline',
    retry: false,
  },
  not_project_member: { copy: null, shownAs: 'not-found', retry: false },
  not_project_facilitator: {
    copy: 'Only the facilitator can change clusters.',
    shownAs: 'toast',
    retry: false,
  },
  cycle_not_clustering: {
    copy: 'The suggestions were not added because the cycle has left the Cluster stage.',
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
    copy: 'This cycle already has 50 clusters, so there is no room for suggestions.',
    shownAs: 'inline',
    retry: false,
  },
  too_many_cards: {
    copy: 'There are too many cards for AI suggestions. They work with up to 300 cards that are not in clusters you made or changed.',
    shownAs: 'inline',
    retry: false,
  },
  ai_run_limit_reached: {
    copy: 'This cycle has used all 20 AI suggestion runs. You can still change the clusters yourself.',
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

describe('aiClusteringErrors', () => {
  it('has the 17 function codes plus network_error and unknown, and nothing else', () => {
    expect(Object.keys(AI_FUNCTION_ERRORS)).toHaveLength(17)
    expect(Object.keys(AI_CLUSTERING_ERRORS).sort()).toEqual(
      [...Object.keys(AI_FUNCTION_ERRORS), 'network_error', 'unknown'].sort(),
    )
  })

  it.each(
    Object.entries(TABLE) as [AiClusteringErrorCode, AiErrorPresentation][],
  )('%s has its copy, place, and Try-again flag', (code, expected) => {
    expect(AI_CLUSTERING_ERRORS[code]).toEqual(expected)
  })

  it('keeps only the code of an error', () => {
    expect(aiClusteringErrorCodeOf(new AiClusteringError('ai_timeout'))).toBe(
      'ai_timeout',
    )
    expect(aiClusteringErrorCodeOf(new Error('ai_timeout'))).toBe('unknown')
  })

  it('maps keep errors and their toasts', () => {
    expect(toKeepErrorCode('not_project_member')).toBe('not_project_member')
    expect(toKeepErrorCode('not_project_facilitator')).toBe(
      'not_project_facilitator',
    )
    expect(toKeepErrorCode('cycle_not_clustering')).toBe('cycle_not_clustering')
    expect(toKeepErrorCode('cluster_not_found')).toBe('unknown')
    expect(toKeepErrorCode(null)).toBe('unknown')
    expect(keepErrorMessage('not_project_member')).toBeNull()
    expect(keepErrorMessage('not_project_facilitator')).toBe(
      'Only the facilitator can change clusters.',
    )
    expect(keepErrorMessage('cycle_not_clustering')).toBe(
      'Clusters can only be changed during the Cluster stage.',
    )
    expect(keepErrorMessage('unknown')).toBe('Could not keep the suggestions.')
    expect(
      keepErrorCodeOf(new KeepAiClustersError('cycle_not_clustering')),
    ).toBe('cycle_not_clustering')
    expect(keepErrorCodeOf(new Error('x'))).toBe('unknown')
  })
})
