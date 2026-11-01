import { vi } from 'vitest'
import type {
  ClosedCycle,
  CycleDetail,
  CreateCycleInput,
  CreatedCycle,
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
  },
}

export function resetCyclesMock(): void {
  cyclesMock.resetCyclesMock()
}
