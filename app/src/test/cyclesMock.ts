import { vi } from 'vitest'
import type {
  ClosedCycle,
  CycleDetail,
  CreateCycleInput,
  CreatedCycle,
  CycleSubmissionStatus,
  ProjectCycles,
} from '../cycles/cyclesApi'
import { CyclesApiError } from '../cycles/cyclesErrors'

/**
 * Shared mock for `src/cycles/cyclesApi.ts`. Every test gets it through
 * `setupTests`, so no test opens a network connection for cycle data.
 */
export const cyclesMock = {
  PAST_CYCLES_LIMIT: 10,
  fetchProjectCycles: vi.fn<(projectId: string) => Promise<ProjectCycles>>(),
  fetchCycle: vi.fn<(cycleId: string) => Promise<CycleDetail | null>>(),
  createCycle: vi.fn<(input: CreateCycleInput) => Promise<CreatedCycle>>(),
  closeCycle: vi.fn<(cycleId: string) => Promise<ClosedCycle>>(),
  fetchCycleStatus:
    vi.fn<(cycleId: string) => Promise<CycleSubmissionStatus>>(),

  resetCyclesMock(): void {
    cyclesMock.fetchProjectCycles
      .mockReset()
      .mockResolvedValue({ current: null, past: [] })
    cyclesMock.fetchCycle.mockReset().mockResolvedValue(null)
    cyclesMock.createCycle
      .mockReset()
      .mockRejectedValue(new CyclesApiError('unknown'))
    cyclesMock.closeCycle
      .mockReset()
      .mockRejectedValue(new CyclesApiError('unknown'))
    // A sole member with no cards, so pages with an open cycle render.
    cyclesMock.fetchCycleStatus.mockReset().mockImplementation((cycleId) =>
      Promise.resolve({
        cycleId,
        status: 'collecting',
        isRevealed: false,
        memberCount: 1,
        submittedMemberCount: 0,
        myCardCount: 0,
        cardCount: null,
      }),
    )
  },
}

export function resetCyclesMock(): void {
  cyclesMock.resetCyclesMock()
}
