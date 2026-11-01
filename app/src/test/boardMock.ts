import { vi } from 'vitest'
import type { CycleBoard } from '../board/boardApi'
import type { SavedCluster } from '../board/clustersApi'
import { ClustersApiError } from '../board/clusterErrors'

/**
 * Shared mock for `src/board/boardApi.ts` and `src/board/clustersApi.ts`.
 * Every test gets it through `setupTests`, so no test opens a network
 * connection for board data, cluster writes, or card moves. By default the board resolves
 * `null` (not found), like `fetchCycle`, and every cluster write fails with
 * `unknown` until a test configures it.
 */
export const boardMock = {
  fetchCycleBoard: vi.fn<(cycleId: string) => Promise<CycleBoard | null>>(),
  createCluster:
    vi.fn<(cycleId: string, name: string) => Promise<SavedCluster>>(),
  renameCluster:
    vi.fn<(clusterId: string, name: string) => Promise<SavedCluster>>(),
  deleteCluster: vi.fn<(clusterId: string) => Promise<void>>(),
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
    boardMock.moveCard
      .mockReset()
      .mockRejectedValue(new ClustersApiError('unknown'))
  },
}

export function resetBoardMock(): void {
  boardMock.resetBoardMock()
}
