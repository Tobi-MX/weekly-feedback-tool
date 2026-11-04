import { vi } from 'vitest'
import { ActionApiError } from '../board/actionErrors'
import type {
  ActionInput,
  ActionStatus,
  CycleActions,
} from '../board/actionsApi'

/**
 * Shared mock for the calls in `src/board/actionsApi.ts` (#26). Every test
 * gets it through `setupTests`, so no test calls `get_cycle_actions` or an
 * action write. By default every call fails with `unknown` until a test
 * configures it.
 */
export const actionsMock = {
  fetchCycleActions: vi.fn<(cycleId: string) => Promise<CycleActions>>(),
  createAction:
    vi.fn<(cycleId: string, input: ActionInput) => Promise<string>>(),
  updateAction:
    vi.fn<(actionId: string, input: ActionInput) => Promise<void>>(),
  setActionStatus:
    vi.fn<(actionId: string, status: ActionStatus) => Promise<void>>(),
  deleteAction: vi.fn<(actionId: string) => Promise<void>>(),

  resetActionsMock(): void {
    const unknown = () => new ActionApiError('unknown')
    actionsMock.fetchCycleActions.mockReset().mockRejectedValue(unknown())
    actionsMock.createAction.mockReset().mockRejectedValue(unknown())
    actionsMock.updateAction.mockReset().mockRejectedValue(unknown())
    actionsMock.setActionStatus.mockReset().mockRejectedValue(unknown())
    actionsMock.deleteAction.mockReset().mockRejectedValue(unknown())
  },
}

export function resetActionsMock(): void {
  actionsMock.resetActionsMock()
}
