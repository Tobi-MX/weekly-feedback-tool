import { useEffect, useSyncExternalStore } from 'react'
import { onlineManager } from '@tanstack/react-query'

// TanStack's onlineManager follows the browser's `online` and `offline`
// events; queries pause and resume with it.
const subscribeOnline = (onChange: () => void) =>
  onlineManager.subscribe(onChange)
const getOnline = () => onlineManager.isOnline()

/** `false` after the browser's `offline` event, until `online`. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnline, getOnline)
}

/**
 * While `active`, reloading or closing the tab shows the browser's leave
 * confirmation. Nothing is written to browser storage.
 */
export function useBeforeUnloadWarning(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older browsers need returnValue set to show the prompt.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [active])
}
