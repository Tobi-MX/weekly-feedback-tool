import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { actionErrorCodeOf } from '@/board/actionErrors'
import { setActionStatus, type ActionStatus } from '@/board/actionsApi'
import { cycleActionsQueryKey } from '@/board/useActions'
import {
  fetchProjectActions,
  type ProjectActionFilters,
  type ProjectActionStatusFilter,
} from './projectActionsApi'

/** How often the list is re-read while the tab is visible (#27). */
export const PROJECT_ACTIONS_POLL_MS = 30_000

/** The project action list's key, scoped by user, project and filters. */
export const projectActionsQueryKey = (
  userId: string | null,
  projectId: string,
  status: ProjectActionStatusFilter,
  mineOnly: boolean,
) => ['project-actions', userId, projectId, status, mineOnly] as const

/** The prefix every filter combination of one project shares. */
export const projectActionsPrefix = (
  userId: string | null,
  projectId: string,
) => ['project-actions', userId, projectId] as const

/**
 * The project's action items under the filters (#27). Re-read on window
 * focus, on reconnect, and every 30 s while the tab is visible (TanStack
 * stops the interval while it is hidden). The project page's cycle-events
 * callback and the status writes invalidate the prefix. After
 * `not_project_member` it stays disabled.
 */
export function useProjectActionsQuery(
  projectId: string,
  filters: ProjectActionFilters,
) {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  const ready = status === 'authenticated' && userId !== null

  return useQuery({
    queryKey: projectActionsQueryKey(
      userId,
      projectId,
      filters.status,
      filters.mineOnly,
    ),
    queryFn: () => fetchProjectActions(projectId, filters),
    enabled: (query) =>
      ready && actionErrorCodeOf(query.state.error) !== 'not_project_member',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: PROJECT_ACTIONS_POLL_MS,
  })
}

export interface ProjectActionStatusWrite {
  readonly actionId: string
  readonly cycleId: string
  readonly status: ActionStatus
}

/**
 * Marks an action done or reopens it through #26's `set_action_status`.
 * Settles only after the project-actions prefix and that cycle's
 * `cycle-actions` key have been invalidated and re-read, on success and on
 * failure. Nothing is written into the cache, so there is nothing to roll
 * back.
 */
export function useSetProjectActionStatus(projectId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  return useMutation({
    mutationFn: (write: ProjectActionStatusWrite) =>
      setActionStatus(write.actionId, write.status),
    onSettled: async (_data, _error, write) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: projectActionsPrefix(userId, projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: cycleActionsQueryKey(userId, write.cycleId),
        }),
      ])
    },
  })
}
