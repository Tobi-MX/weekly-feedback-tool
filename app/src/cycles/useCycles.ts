import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import {
  closeCycle,
  createCycle,
  fetchCycle,
  fetchCycleStatus,
  fetchProjectCycles,
  type CreateCycleInput,
} from './cyclesApi'
import { cyclesErrorCodeOf } from './cyclesErrors'

export const projectCyclesQueryKey = (
  userId: string | null,
  projectId: string,
) => ['project-cycles', userId, projectId] as const

export const cycleQueryKey = (userId: string | null, cycleId: string) =>
  ['cycle', userId, cycleId] as const

/**
 * The submission status of one cycle. Exported so #14 can invalidate it after
 * the retrospective starts.
 */
export const cycleStatusQueryKey = (userId: string | null, cycleId: string) =>
  ['cycle-status', userId, cycleId] as const

function useUserId() {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  return { userId, ready: status === 'authenticated' && userId !== null }
}

/** A project's current and past cycles, scoped by user and project id. */
export function useProjectCyclesQuery(projectId: string | undefined) {
  const { userId, ready } = useUserId()

  return useQuery({
    queryKey: projectCyclesQueryKey(userId, projectId ?? ''),
    queryFn: () => fetchProjectCycles(projectId ?? ''),
    enabled: ready && Boolean(projectId),
  })
}

/**
 * One cycle by id, scoped by user and cycle id. It is re-read when the window
 * regains focus and when the browser reconnects, so a page that depends on the
 * stage sees a change without a reload (the app default turns focus off).
 */
export function useCycleQuery(cycleId: string, enabled: boolean) {
  const { userId, ready } = useUserId()

  return useQuery({
    queryKey: cycleQueryKey(userId, cycleId),
    queryFn: () => fetchCycle(cycleId),
    enabled: ready && enabled,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
}

/**
 * The cycle's aggregate submission status. It is not live: it is read on
 * mount, when the window regains focus, on reconnect, and on Retry, with no
 * polling interval. After `not_project_member` it stays disabled, so no
 * further status request is sent.
 */
export function useCycleStatusQuery(cycleId: string) {
  const { userId, ready } = useUserId()

  return useQuery({
    queryKey: cycleStatusQueryKey(userId, cycleId),
    queryFn: () => fetchCycleStatus(cycleId),
    enabled: (query) =>
      ready && cyclesErrorCodeOf(query.state.error) !== 'not_project_member',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
}

/** Invalidates the project's cycles query. */
export function useInvalidateProjectCycles(projectId: string) {
  const { userId } = useUserId()
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: projectCyclesQueryKey(userId, projectId),
    })
}

/** Starting a cycle refetches the list; nothing is optimistic. */
export function useCreateCycle(projectId: string) {
  const invalidate = useInvalidateProjectCycles(projectId)

  return useMutation({
    mutationFn: (input: Omit<CreateCycleInput, 'projectId'>) =>
      createCycle({ ...input, projectId }),
    onSuccess: () => invalidate(),
  })
}

/** Closing a cycle refetches the list; nothing is optimistic. */
export function useCloseCycle(projectId: string) {
  const invalidate = useInvalidateProjectCycles(projectId)

  return useMutation({
    mutationFn: (cycleId: string) => closeCycle(cycleId),
    onSuccess: () => invalidate(),
  })
}
