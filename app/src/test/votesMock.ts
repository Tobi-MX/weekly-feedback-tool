import { vi } from 'vitest'
import { VotesApiError } from '../board/voteErrors'
import type { VoteTotal } from '../board/voteTotalsApi'
import type { VoteResult } from '../board/votesApi'

// The real error class, so the board's code checks see the same class the
// mocked fetchVoteTotals rejects with (voteTotalsApi is itself mocked).
const { VoteTotalsApiError } = await vi.importActual<
  typeof import('../board/voteTotalsApi')
>('../board/voteTotalsApi')

/**
 * Shared mock for `src/board/votesApi.ts` (#23) and `fetchVoteTotals` in
 * `src/board/voteTotalsApi.ts` (#24). Every test gets it through
 * `setupTests`, so no test calls `cast_vote`, `remove_vote`, or
 * `get_vote_totals`. By default all three fail with `unknown` until a test
 * configures them.
 */
export const votesMock = {
  castVote:
    vi.fn<(cycleId: string, clusterId: string) => Promise<VoteResult>>(),
  removeVote:
    vi.fn<(cycleId: string, clusterId: string) => Promise<VoteResult>>(),
  fetchVoteTotals: vi.fn<(cycleId: string) => Promise<readonly VoteTotal[]>>(),

  resetVotesMock(): void {
    votesMock.castVote
      .mockReset()
      .mockRejectedValue(new VotesApiError('unknown'))
    votesMock.removeVote
      .mockReset()
      .mockRejectedValue(new VotesApiError('unknown'))
    votesMock.fetchVoteTotals
      .mockReset()
      .mockRejectedValue(new VoteTotalsApiError('unknown'))
  },
}

export function resetVotesMock(): void {
  votesMock.resetVotesMock()
}
