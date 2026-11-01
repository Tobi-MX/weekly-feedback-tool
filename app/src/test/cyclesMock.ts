import { vi } from 'vitest'
import type {
  ClosedCycle,
  CycleDetail,
  CycleEventsHandlers,
  CycleEventsStatus,
  CreateCycleInput,
  CreatedCycle,
  CycleSubmissionStatus,
  ProjectCycles,
  StartedRetrospective,
} from '../cycles/cyclesApi'
import { CyclesApiError } from '../cycles/cyclesErrors'

/** One `subscribeToCycleEvents` call the mock has seen. */
export interface CycleEventsSubscription {
  readonly cycleId: string
  readonly handlers: CycleEventsHandlers
  active: boolean
}

const subscriptions: CycleEventsSubscription[] = []

/** The default stand-in: records the subscription, opens no WebSocket. */
function recordSubscription(
  cycleId: string,
  handlers: CycleEventsHandlers,
): () => void {
  const subscription: CycleEventsSubscription = {
    cycleId,
    handlers,
    active: true,
  }
  subscriptions.push(subscription)
  return () => {
    subscription.active = false
  }
}

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
  startRetrospective:
    vi.fn<(cycleId: string) => Promise<StartedRetrospective>>(),
  subscribeToCycleEvents:
    vi.fn<(cycleId: string, handlers: CycleEventsHandlers) => () => void>(),

  /** Every subscription seen since the last reset, live or removed. */
  cycleEventsSubscriptions(): readonly CycleEventsSubscription[] {
    return subscriptions
  },

  /** The subscriptions that have not been unsubscribed. */
  activeCycleEventsSubscriptions(): readonly CycleEventsSubscription[] {
    return subscriptions.filter((subscription) => subscription.active)
  },

  /** Delivers one event to every live subscriber of the cycle. */
  emitCycleEvent(cycleId: string): void {
    for (const subscription of cyclesMock.activeCycleEventsSubscriptions()) {
      if (subscription.cycleId === cycleId) {
        subscription.handlers.onEvent()
      }
    }
  },

  /** Reports a channel status to every live subscriber of the cycle. */
  emitCycleEventsStatus(cycleId: string, status: CycleEventsStatus): void {
    for (const subscription of cyclesMock.activeCycleEventsSubscriptions()) {
      if (subscription.cycleId === cycleId) {
        subscription.handlers.onStatus?.(status)
      }
    }
  },

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
    cyclesMock.startRetrospective
      .mockReset()
      .mockRejectedValue(new CyclesApiError('unknown'))
    subscriptions.length = 0
    cyclesMock.subscribeToCycleEvents
      .mockReset()
      .mockImplementation(recordSubscription)
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
