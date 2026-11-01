import { act, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { cyclesMock } from '../test/cyclesMock'
import { useCycleEvents } from './useCycleEvents'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const OTHER_ID = '30000000-0000-4000-8000-000000000002'

describe('useCycleEvents connection state', () => {
  it('is connecting, then live after SUBSCRIBED, unavailable after an error, and live again', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useCycleEvents(CYCLE_ID, onChange))

    expect(result.current).toBe('connecting')
    expect(onChange).not.toHaveBeenCalled()

    act(() => {
      cyclesMock.emitCycleEventsStatus(CYCLE_ID, 'SUBSCRIBED')
    })
    expect(result.current).toBe('live')
    expect(onChange).toHaveBeenCalledTimes(1)

    for (const status of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const) {
      act(() => {
        cyclesMock.emitCycleEventsStatus(CYCLE_ID, status)
      })
      expect(result.current).toBe('unavailable')
    }
    expect(onChange).toHaveBeenCalledTimes(1)

    act(() => {
      cyclesMock.emitCycleEventsStatus(CYCLE_ID, 'SUBSCRIBED')
    })
    expect(result.current).toBe('live')
    expect(onChange).toHaveBeenCalledTimes(2)

    act(() => {
      cyclesMock.emitCycleEvent(CYCLE_ID)
    })
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('has no channel and reads connecting for a null cycle id', () => {
    const { result } = renderHook(() => useCycleEvents(null, vi.fn()))

    expect(result.current).toBe('connecting')
    expect(cyclesMock.subscribeToCycleEvents).not.toHaveBeenCalled()
  })

  it('starts a new cycle id as connecting and removes the old channel', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useCycleEvents(id, vi.fn()),
      { initialProps: { id: CYCLE_ID as string | null } },
    )
    act(() => {
      cyclesMock.emitCycleEventsStatus(CYCLE_ID, 'CHANNEL_ERROR')
    })
    expect(result.current).toBe('unavailable')

    rerender({ id: OTHER_ID })
    expect(result.current).toBe('connecting')
    expect(
      cyclesMock.activeCycleEventsSubscriptions().map((s) => s.cycleId),
    ).toEqual([OTHER_ID])

    rerender({ id: null })
    expect(result.current).toBe('connecting')
    expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(0)
  })

  it('leaves exactly one live subscription under strict mode', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    )
    const { unmount } = renderHook(() => useCycleEvents(CYCLE_ID, vi.fn()), {
      wrapper,
    })

    expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    unmount()
    expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(0)
  })
})
