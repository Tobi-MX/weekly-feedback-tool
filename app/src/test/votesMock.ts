import { vi } from 'vitest'
import { VotesApiError } from '../board/voteErrors'
import type { VoteResult } from '../board/votesApi'

/**
 * Shared mock for `src/board/votesApi.ts` (#23). Every test gets it through
 * `setupTests`, so no test calls `cast_vote` or `remove_vote`. By default
 * both fail with `unknown` until a test configures them.
 */
export const votesMock = {
  castVote:
    vi.fn<(cycleId: string, clusterId: string) => Promise<VoteResult>>(),
  removeVote:
    vi.fn<(cycleId: string, clusterId: string) => Promise<VoteResult>>(),

  resetVotesMock(): void {
    votesMock.castVote
      .mockReset()
      .mockRejectedValue(new VotesApiError('unknown'))
    votesMock.removeVote
      .mockReset()
      .mockRejectedValue(new VotesApiError('unknown'))
  },
}

export function resetVotesMock(): void {
  votesMock.resetVotesMock()
}
