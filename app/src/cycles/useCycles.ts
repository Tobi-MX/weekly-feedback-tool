import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import {
  closeCycle,
  createCycle,
  fetchProjectCycles,
  type CreateCycleInput,
} from './cyclesApi'

export const projectCyclesQueryKey = (
  userId: string | null,
  projectId: string,
) => ['project-cycles', userId, projectId] as const

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
