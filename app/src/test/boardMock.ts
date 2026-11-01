import { vi } from 'vitest'
import type { CycleBoard } from '../board/boardApi'

/**
 * Shared mock for `src/board/boardApi.ts`. Every test gets it through
 * `setupTests`, so no test opens a network connection for board data. By
 * default the board resolves `null` (not found), like `fetchCycle`.
 */
export const boardMock = {
  fetchCycleBoard: vi.fn<(cycleId: string) => Promise<CycleBoard | null>>(),

  resetBoardMock(): void {
    boardMock.fetchCycleBoard.mockReset().mockResolvedValue(null)
  },
}

export function resetBoardMock(): void {
  boardMock.resetBoardMock()
}
