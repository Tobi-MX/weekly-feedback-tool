import { useEffect, useRef } from 'react'
import { subscribeToCycleEvents } from './cyclesApi'

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
 */
export function useCycleEvents(
  cycleId: string | null,
  onChange: () => void,
): void {
  const onChangeRef = useRef(onChange)

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
        if (status === 'SUBSCRIBED') {
          onChangeRef.current()
        }
      },
    })
  }, [cycleId])
}
