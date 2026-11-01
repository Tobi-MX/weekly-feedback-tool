import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CycleEventsStatus } from './cycleEventsApi'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

const { subscribeToCycleEvents, cycleEventsChannelName } =
  await vi.importActual<typeof import('./cycleEventsApi')>('./cycleEventsApi')

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const OTHER_CYCLE_ID = '30000000-0000-4000-8000-000000000002'

type Listener = (payload: unknown) => void
type StatusCallback = (status: CycleEventsStatus) => void

interface FakeChannel {
  readonly name: string
  readonly bindings: { type: string; filter: unknown; callback: Listener }[]
  statusCallback: StatusCallback | null
  subscribeCalls: number
  on: (type: string, filter: unknown, callback: Listener) => FakeChannel
  subscribe: (callback: StatusCallback) => FakeChannel
}

/** A recording stand-in for the supabase-js Realtime channel API. */
function createRealtimeMock() {
  const channels: FakeChannel[] = []
  const pendingRemovals: (() => void)[] = []

  const channel = vi.fn((name: string) => {
    const fake: FakeChannel = {
      name,
      bindings: [],
      statusCallback: null,
      subscribeCalls: 0,
      on(type, filter, callback) {
        fake.bindings.push({ type, filter, callback })
        return fake
      },
      subscribe(callback) {
        fake.subscribeCalls += 1
        fake.statusCallback = callback
        return fake
      },
    }
    channels.push(fake)
    return fake
  })

  const removeChannel = vi.fn(
    (_channel: FakeChannel) =>
      new Promise<'ok'>((resolve) => {
        pendingRemovals.push(() => {
          resolve('ok')
        })
      }),
  )

  state.client = { channel, removeChannel }
  return {
    channel,
    removeChannel,
    channels,
    /** Finishes every removal still in flight. */
    finishRemoval: () => {
      for (const finish of pendingRemovals.splice(0)) {
        finish()
      }
    },
  }
}

/** Lets queued promise callbacks and microtasks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

/** Runs the removal timer and lets a removal finish. */
async function settleRemoval(
  realtime: ReturnType<typeof createRealtimeMock>,
): Promise<void> {
  vi.runOnlyPendingTimers()
  realtime.finishRemoval()
  await flush()
}

beforeEach(() => {
  state.client = null
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('subscribeToCycleEvents', () => {
  it('opens one channel listening to INSERT on public.cycle_events for the cycle', async () => {
    const realtime = createRealtimeMock()

    const unsubscribe = subscribeToCycleEvents(CYCLE_ID, {
      onEvent: vi.fn(),
    })

    expect(realtime.channel).toHaveBeenCalledTimes(1)
    expect(realtime.channel).toHaveBeenCalledWith(`cycle-events:${CYCLE_ID}`)
    expect(cycleEventsChannelName(CYCLE_ID)).toBe(`cycle-events:${CYCLE_ID}`)
    const [fake] = realtime.channels
    expect(fake?.bindings).toHaveLength(1)
    expect(fake?.bindings[0]?.type).toBe('postgres_changes')
    expect(fake?.bindings[0]?.filter).toStrictEqual({
      event: 'INSERT',
      schema: 'public',
      table: 'cycle_events',
      filter: `cycle_id=eq.${CYCLE_ID}`,
    })
    expect(fake?.subscribeCalls).toBe(1)

    unsubscribe()
    await settleRemoval(realtime)
  })

  it('passes nothing from the message to onEvent and logs nothing', async () => {
    const realtime = createRealtimeMock()
    const onEvent = vi.fn()
    const unsubscribe = subscribeToCycleEvents(CYCLE_ID, { onEvent })

    realtime.channels[0]?.bindings[0]?.callback({
      eventType: 'INSERT',
      new: {
        id: 'event-1',
        cycle_id: CYCLE_ID,
        actor_id: 'user-secret',
        to_status: 'reveal',
      },
    })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith()
    expect(console.log).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()

    unsubscribe()
    await settleRemoval(realtime)
  })

  it('reports every channel status to onStatus', async () => {
    const realtime = createRealtimeMock()
    const onStatus = vi.fn()
    const unsubscribe = subscribeToCycleEvents(CYCLE_ID, {
      onEvent: vi.fn(),
      onStatus,
    })

    const report = realtime.channels[0]?.statusCallback
    report?.('SUBSCRIBED')
    report?.('CHANNEL_ERROR')
    report?.('SUBSCRIBED')

    expect(onStatus.mock.calls).toEqual([
      ['SUBSCRIBED'],
      ['CHANNEL_ERROR'],
      ['SUBSCRIBED'],
    ])

    unsubscribe()
    await settleRemoval(realtime)
  })

  it('removes the channel after unsubscribe, and stops calling the handlers', async () => {
    const realtime = createRealtimeMock()
    const onEvent = vi.fn()
    const unsubscribe = subscribeToCycleEvents(CYCLE_ID, { onEvent })
    const [fake] = realtime.channels

    unsubscribe()
    fake?.bindings[0]?.callback({})
    expect(onEvent).not.toHaveBeenCalled()

    vi.runOnlyPendingTimers()
    expect(realtime.removeChannel).toHaveBeenCalledTimes(1)
    expect(realtime.removeChannel).toHaveBeenCalledWith(fake)

    // A second call of the same unsubscribe does nothing.
    unsubscribe()
    vi.runOnlyPendingTimers()
    expect(realtime.removeChannel).toHaveBeenCalledTimes(1)

    realtime.finishRemoval()
    await flush()
  })

  it('keeps one channel through a synchronous unsubscribe and resubscribe (strict mode)', async () => {
    const realtime = createRealtimeMock()
    const first = vi.fn()
    const second = vi.fn()

    subscribeToCycleEvents(CYCLE_ID, { onEvent: first })()
    const unsubscribe = subscribeToCycleEvents(CYCLE_ID, { onEvent: second })
    vi.runOnlyPendingTimers()

    expect(realtime.channel).toHaveBeenCalledTimes(1)
    expect(realtime.removeChannel).not.toHaveBeenCalled()
    realtime.channels[0]?.bindings[0]?.callback({})
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    unsubscribe()
    await settleRemoval(realtime)
    expect(realtime.removeChannel).toHaveBeenCalledTimes(1)
  })

  it('waits for a leaving channel before opening a fresh one', async () => {
    const realtime = createRealtimeMock()

    subscribeToCycleEvents(CYCLE_ID, { onEvent: vi.fn() })()
    vi.runOnlyPendingTimers()
    expect(realtime.removeChannel).toHaveBeenCalledTimes(1)

    const onEvent = vi.fn()
    const unsubscribe = subscribeToCycleEvents(CYCLE_ID, { onEvent })
    expect(realtime.channel).toHaveBeenCalledTimes(1)

    realtime.finishRemoval()
    await flush()
    expect(realtime.channel).toHaveBeenCalledTimes(2)
    realtime.channels[1]?.bindings[0]?.callback({})
    expect(onEvent).toHaveBeenCalledTimes(1)

    unsubscribe()
    await settleRemoval(realtime)
  })

  it('gives a late subscriber of a subscribed channel its own SUBSCRIBED', async () => {
    const realtime = createRealtimeMock()
    const unsubscribeFirst = subscribeToCycleEvents(CYCLE_ID, {
      onEvent: vi.fn(),
    })
    realtime.channels[0]?.statusCallback?.('SUBSCRIBED')

    const onStatus = vi.fn()
    const unsubscribeSecond = subscribeToCycleEvents(CYCLE_ID, {
      onEvent: vi.fn(),
      onStatus,
    })
    await flush()

    expect(realtime.channel).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledWith('SUBSCRIBED')

    unsubscribeFirst()
    unsubscribeSecond()
    await settleRemoval(realtime)
    expect(realtime.removeChannel).toHaveBeenCalledTimes(1)
  })

  it('opens one channel per cycle', async () => {
    const realtime = createRealtimeMock()
    const a = subscribeToCycleEvents(CYCLE_ID, { onEvent: vi.fn() })
    const b = subscribeToCycleEvents(OTHER_CYCLE_ID, { onEvent: vi.fn() })

    expect(realtime.channel.mock.calls).toEqual([
      [`cycle-events:${CYCLE_ID}`],
      [`cycle-events:${OTHER_CYCLE_ID}`],
    ])

    a()
    b()
    vi.runOnlyPendingTimers()
    expect(realtime.removeChannel).toHaveBeenCalledTimes(2)
    realtime.finishRemoval()
    await flush()
  })

  it('does nothing when Supabase is not configured', () => {
    const unsubscribe = subscribeToCycleEvents(CYCLE_ID, { onEvent: vi.fn() })
    expect(() => {
      unsubscribe()
    }).not.toThrow()
  })
})
