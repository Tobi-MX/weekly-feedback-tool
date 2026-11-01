import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { fetchCycleBoard } from './boardApi'
import { boardErrorCodeOf } from './boardErrors'
import { cycleBoardQueryKey } from './boardKeys'

export { cycleBoardQueryKey } from './boardKeys'

/** How often the board and cycle are re-read while Realtime is unavailable. */
export const BOARD_POLL_INTERVAL_MS = 4000

/**
 * The board of one cycle, scoped by user and cycle id. It is re-read on
 * window focus, on reconnect, on every cycle event, and every
 * `refetchInterval` ms while Realtime is unavailable (never while the tab is
 * hidden). After `not_project_member` it stays disabled, so no further board
 * request is sent.
 */
export function useCycleBoardQuery(
  cycleId: string,
  enabled: boolean,
  refetchInterval: number | false,
) {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  const ready = status === 'authenticated' && userId !== null

  return useQuery({
    queryKey: cycleBoardQueryKey(userId, cycleId),
    queryFn: () => fetchCycleBoard(cycleId),
    enabled: (query) =>
      ready &&
      enabled &&
      boardErrorCodeOf(query.state.error) !== 'not_project_member',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval,
  })
}
