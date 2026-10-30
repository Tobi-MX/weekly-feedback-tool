import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { fetchProfileDisplayName } from './profileApi'

export const profileQueryKey = (userId: string | null) =>
  ['profile', userId] as const

export interface ProfileDisplay {
  /** The profile row's display name, or null when absent or unusable. */
  readonly displayName: string | null
  /** The account email, used as the fallback label. */
  readonly email: string | null
  /** A label that is never blank or undefined. */
  readonly label: string
}

/**
 * Reads the signed-in user's display name through TanStack Query. The query is
 * disabled until auth has resolved to an authenticated user, and any pending,
 * failed, or empty result falls back to the account email.
 */
export function useProfileDisplay(): ProfileDisplay {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  const email = user?.email?.trim() ? user.email.trim() : null

  const { data } = useQuery({
    queryKey: profileQueryKey(userId),
    queryFn: () => {
      if (!userId) {
        throw new Error('No authenticated user.')
      }
      return fetchProfileDisplayName(userId)
    },
    enabled: status === 'authenticated' && userId !== null,
    staleTime: 5 * 60 * 1000,
  })

  const displayName =
    typeof data === 'string' && data.trim() ? data.trim() : null
  const label = displayName ?? email ?? 'Account'

  return { displayName, email, label }
}
