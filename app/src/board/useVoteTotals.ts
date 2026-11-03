import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { fetchVoteTotals, voteTotalsErrorCodeOf } from './voteTotalsApi'

/** The vote totals query's key, scoped by user and cycle id. */
export const voteTotalsQueryKey = (userId: string | null, cycleId: string) =>
  ['vote-totals', userId, cycleId] as const

/**
 * The cycle's vote totals (#24). Enabled only while the board shows discuss,
 * so `get_vote_totals` is never called in any other stage. The board's
 * `invalidateAll` re-reads it on every cycle event. After
 * `not_project_member` it stays disabled.
 */
export function useVoteTotalsQuery(cycleId: string, enabled: boolean) {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  const ready = status === 'authenticated' && userId !== null

  return useQuery({
    queryKey: voteTotalsQueryKey(userId, cycleId),
    queryFn: () => fetchVoteTotals(cycleId),
    enabled: (query) =>
      ready &&
      enabled &&
      voteTotalsErrorCodeOf(query.state.error) !== 'not_project_member',
  })
}
