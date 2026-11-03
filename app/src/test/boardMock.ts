import { vi } from 'vitest'
import type { CycleBoard } from '../board/boardApi'
import type { SavedCluster } from '../board/clustersApi'
import { ClustersApiError } from '../board/clusterErrors'

/**
 * Shared mock for `src/board/boardApi.ts` and `src/board/clustersApi.ts`.
 * Every test gets it through `setupTests`, so no test opens a network
 * connection for board data, cluster writes (merge and split included), or
 * card moves. By default the board resolves
 * `null` (not found), like `fetchCycle`, and every cluster write fails with
 * `unknown` until a test configures it.
 */
/**
 * The caller's vote fields of a board where the caller has not voted (#22):
 * no own votes and the full budget. Board fixtures spread this.
 */
export const NO_VOTES: Pick<CycleBoard, 'myVotes' | 'votesRemaining'> = {
  myVotes: [],
  votesRemaining: 3,
}

export const boardMock = {
  fetchCycleBoard: vi.fn<(cycleId: string) => Promise<CycleBoard | null>>(),
  createCluster:
    vi.fn<(cycleId: string, name: string) => Promise<SavedCluster>>(),
  renameCluster:
    vi.fn<(clusterId: string, name: string) => Promise<SavedCluster>>(),
  deleteCluster: vi.fn<(clusterId: string) => Promise<void>>(),
  mergeClusters:
    vi.fn<
      (
        sourceClusterId: string,
        targetClusterId: string,
      ) => Promise<SavedCluster>
    >(),
  splitCluster:
    vi.fn<
      (
        clusterId: string,
        cardIds: readonly string[],
        name: string,
      ) => Promise<SavedCluster>
    >(),
  moveCard:
    vi.fn<
      (
        cardId: string,
        clusterId: string | null,
        position: number | null,
      ) => Promise<void>
    >(),

  resetBoardMock(): void {
    boardMock.fetchCycleBoard.mockReset().mockResolvedValue(null)
    boardMock.createCluster
      .mockReset()
      .mockRejectedValue(new ClustersApiError('unknown'))
    boardMock.renameCluster
      .mockReset()
      .mockRejectedValue(new ClustersApiError('unknown'))
    boardMock.deleteCluster
      .mockReset()
      .mockRejectedValue(new ClustersApiError('unknown'))
    boardMock.mergeClusters
      .mockReset()
      .mockRejectedValue(new ClustersApiError('unknown'))
    boardMock.splitCluster
      .mockReset()
      .mockRejectedValue(new ClustersApiError('unknown'))
    boardMock.moveCard
      .mockReset()
      .mockRejectedValue(new ClustersApiError('unknown'))
  },
}

export function resetBoardMock(): void {
  boardMock.resetBoardMock()
}
