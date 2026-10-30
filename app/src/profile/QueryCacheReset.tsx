import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'

/**
 * Clears all server state when the signed-in user changes or signs out, so a
 * later session can never read the previous user's cached profile.
 */
export function QueryCacheReset() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const previousUserId = useRef<string | null>(userId)

  useEffect(() => {
    if (previousUserId.current !== null && previousUserId.current !== userId) {
      queryClient.clear()
    }
    previousUserId.current = userId
  }, [queryClient, userId])

  return null
}

export default QueryCacheReset
