import { useEffect, useRef, useState } from 'react'
import { subscribeToCycleEvents } from './cyclesApi'

/**
 * The connection state of a `useCycleEvents` channel: `connecting` until the
 * channel first reports a state, `live` after `SUBSCRIBED`, and `unavailable`
 * after `CHANNEL_ERROR`, `TIMED_OUT`, or `CLOSED` (until the next
 * `SUBSCRIBED`). With a null `cycleId` there is no channel and the state is
 * `connecting`.
 */
export type CycleEventsConnection = 'connecting' | 'live' | 'unavailable'

interface ConnectionState {
  readonly cycleId: string
  readonly connection: CycleEventsConnection
}

/**
 * Keeps one live `cycle_events` subscription for `cycleId` while it is set,
 * and calls `onChange` on every event and every time the channel reports
 * `SUBSCRIBED` (the first time too, so an event between the caller's first
 * read and the subscription is not missed, and again after a reconnect).
 * `onChange` gets nothing from the message: callers re-read through the RPCs.
 *
 * With a null `cycleId` there is no channel. The channel is removed on
 * unmount and when `cycleId` changes. The project page uses it; #16's board
 * and #71's feedback form reuse it.
 *
 * Returns the channel's connection state, so a caller can fall back to
 * polling while Realtime is unavailable (#16). Callers that ignore it keep
 * #14's behaviour.
 */
export function useCycleEvents(
  cycleId: string | null,
  onChange: () => void,
): CycleEventsConnection {
  const onChangeRef = useRef(onChange)
  // Keyed by cycle id, so a new cycle starts as `connecting` without a reset.
  const [state, setState] = useState<ConnectionState | null>(null)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (cycleId === null) {
      return
    }
    return subscribeToCycleEvents(cycleId, {
      onEvent: () => {
        onChangeRef.current()
      },
      onStatus: (status) => {
        setState({
          cycleId,
          connection: status === 'SUBSCRIBED' ? 'live' : 'unavailable',
        })
        if (status === 'SUBSCRIBED') {
          onChangeRef.current()
        }
      },
    })
  }, [cycleId])

  if (cycleId === null || state === null || state.cycleId !== cycleId) {
    return 'connecting'
  }
  return state.connection
}
