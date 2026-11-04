import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { actionErrorCodeOf, type ActionWrite } from './actionErrors'
import {
  createAction,
  deleteAction,
  fetchCycleActions,
  setActionStatus,
  updateAction,
  type ActionInput,
  type ActionStatus,
} from './actionsApi'

/** The actions query's key, scoped by user and cycle id. */
export const cycleActionsQueryKey = (userId: string | null, cycleId: string) =>
  ['cycle-actions', userId, cycleId] as const

/**
 * The cycle's action items (#26). Enabled only while the board shows
 * discuss, so `get_cycle_actions` is never called in any other stage. It
 * polls with the board's interval (only while Realtime is unavailable) and
 * is re-read by the board's `invalidateAll` on every cycle event, on
 * `SUBSCRIBED`, on focus, and on reconnect. After `not_project_member` it
 * stays disabled.
 */
export function useCycleActionsQuery(
  cycleId: string,
  enabled: boolean,
  refetchInterval: number | false,
) {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  const ready = status === 'authenticated' && userId !== null

  return useQuery({
    queryKey: cycleActionsQueryKey(userId, cycleId),
    queryFn: () => fetchCycleActions(cycleId),
    enabled: (query) =>
      ready &&
      enabled &&
      actionErrorCodeOf(query.state.error) !== 'not_project_member',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval,
  })
}

/**
 * Runs on every failed write, even after discuss mode has unmounted (the
 * callback lives on the mutation), so a write that fails after the stage
 * moved on still shows its toast.
 */
export type ActionFailure = (error: unknown, write: ActionWrite) => void

/** An action write: create, edit, status, or delete. One at a time. */
export type ActionWriteInput =
  | { readonly kind: 'create'; readonly input: ActionInput }
  | {
      readonly kind: 'edit'
      readonly actionId: string
      readonly input: ActionInput
    }
  | {
      readonly kind: 'status'
      readonly actionId: string
      readonly status: ActionStatus
    }
  | { readonly kind: 'delete'; readonly actionId: string }

/**
 * The action writes. Each settles only after the actions re-read it starts
 * has finished, so a change shows once the refetch is in. Nothing is written
 * into the cache.
 */
export function useActionWrite(cycleId: string, onFailure: ActionFailure) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  return useMutation({
    mutationFn: async (write: ActionWriteInput): Promise<void> => {
      switch (write.kind) {
        case 'create':
          await createAction(cycleId, write.input)
          return
        case 'edit':
          await updateAction(write.actionId, write.input)
          return
        case 'status':
          await setActionStatus(write.actionId, write.status)
          return
        case 'delete':
          await deleteAction(write.actionId)
          return
      }
    },
    onError: (error, write) => {
      onFailure(error, write.kind)
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: cycleActionsQueryKey(userId, cycleId),
      }),
  })
}
