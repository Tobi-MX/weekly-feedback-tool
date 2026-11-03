import { CLUSTER_GONE_MESSAGE } from './clusterErrors'

/**
 * The stable codes `cast_vote` and `remove_vote` raise (#22). Anything else
 * (a network failure, a reply that does not match the narrow row schema) is
 * `unknown`. Nothing else from a Postgres error is ever kept, shown, or
 * logged.
 */
export const VOTE_ERROR_CODES = [
  'not_project_member',
  'cycle_not_voting',
  'cluster_not_found',
  'no_votes_remaining',
  'no_vote_to_remove',
] as const

export type VoteErrorCode = (typeof VOTE_ERROR_CODES)[number] | 'unknown'

/** Which vote write failed; the copy depends on it. */
export type VoteOperation = 'add' | 'remove'

export const VOTE_NOT_VOTING_MESSAGE =
  'Votes can only be changed during the Vote stage.'
export const NO_VOTES_REMAINING_MESSAGE =
  'You have already used all 3 votes. Remove one to vote again.'
export const NO_VOTE_TO_REMOVE_MESSAGE =
  'You have no vote on this cluster to remove.'
export const ADD_VOTE_FAILED_MESSAGE = 'Could not add your vote.'
export const REMOVE_VOTE_FAILED_MESSAGE = 'Could not remove your vote.'

/**
 * The toast for every code and write. `null` means no toast: the board
 * switches to its not-found state instead. A `Record` over every code, so a
 * code without copy fails the typecheck.
 */
export const VOTE_ERROR_MESSAGES: Record<
  VoteErrorCode,
  Record<VoteOperation, string | null>
> = {
  not_project_member: { add: null, remove: null },
  cycle_not_voting: {
    add: VOTE_NOT_VOTING_MESSAGE,
    remove: VOTE_NOT_VOTING_MESSAGE,
  },
  cluster_not_found: {
    add: CLUSTER_GONE_MESSAGE,
    remove: CLUSTER_GONE_MESSAGE,
  },
  // Each write raises only its own code; the other gets the unknown copy.
  no_votes_remaining: {
    add: NO_VOTES_REMAINING_MESSAGE,
    remove: REMOVE_VOTE_FAILED_MESSAGE,
  },
  no_vote_to_remove: {
    add: ADD_VOTE_FAILED_MESSAGE,
    remove: NO_VOTE_TO_REMOVE_MESSAGE,
  },
  unknown: {
    add: ADD_VOTE_FAILED_MESSAGE,
    remove: REMOVE_VOTE_FAILED_MESSAGE,
  },
}

/**
 * The toast for a failed vote write, or null for `not_project_member`, which
 * switches the board to its not-found state instead.
 */
export function voteErrorMessage(
  code: VoteErrorCode,
  operation: VoteOperation,
): string | null {
  return VOTE_ERROR_MESSAGES[code][operation]
}

/** An error that carries only a stable code, never the server's text. */
export class VotesApiError extends Error {
  readonly code: VoteErrorCode

  constructor(code: VoteErrorCode) {
    super(code)
    this.name = 'VotesApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to a stable code, else `unknown`. */
export function toVoteErrorCode(
  message: string | null | undefined,
): VoteErrorCode {
  return VOTE_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

export function voteErrorCodeOf(error: unknown): VoteErrorCode {
  return error instanceof VotesApiError ? error.code : 'unknown'
}
