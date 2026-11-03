import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { cycleBoardQueryKey } from './boardKeys'
import {
  addNote,
  deleteNote,
  fetchDiscussion,
  setDiscussionStatus,
  updateNote,
  type DiscussionStatus,
} from './discussionApi'
import { discussionErrorCodeOf, type DiscussionWrite } from './discussionErrors'

/** The discussion query's key, scoped by user and cycle id. */
export const discussionQueryKey = (userId: string | null, cycleId: string) =>
  ['cycle-discussion', userId, cycleId] as const

/**
 * The cycle's statuses and notes (#25). Enabled only while the board shows
 * discuss, so `get_cycle_discussion` is never called in any other stage. It
 * polls with the board's interval (only while Realtime is unavailable) and
 * is re-read by the board's `invalidateAll` on every cycle event, on
 * `SUBSCRIBED`, on focus, and on reconnect. After `not_project_member` it
 * stays disabled.
 */
export function useDiscussionQuery(
  cycleId: string,
  enabled: boolean,
  refetchInterval: number | false,
) {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  const ready = status === 'authenticated' && userId !== null

  return useQuery({
    queryKey: discussionQueryKey(userId, cycleId),
    queryFn: () => fetchDiscussion(cycleId),
    enabled: (query) =>
      ready &&
      enabled &&
      discussionErrorCodeOf(query.state.error) !== 'not_project_member',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval,
  })
}

/**
 * Re-reads the discussion (and, for a status, the board) and returns that
 * promise, so a write settles only once the refetch it starts is in.
 * Nothing is written into the cache.
 */
function useAwaitedInvalidation(cycleId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  return (withBoard: boolean) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: discussionQueryKey(userId, cycleId),
      }),
      withBoard
        ? queryClient.invalidateQueries({
            queryKey: cycleBoardQueryKey(userId, cycleId),
          })
        : Promise.resolve(),
    ]).then(() => undefined)
}

/**
 * Runs on every failed write, even after discuss mode has unmounted (the
 * callback lives on the mutation), so a write that fails after the stage
 * moved on still shows its toast.
 */
export type DiscussionFailure = (error: unknown, write: DiscussionWrite) => void

export interface StatusWriteInput {
  readonly clusterId: string
  readonly status: DiscussionStatus
}

export function useSetDiscussionStatus(
  cycleId: string,
  onFailure: DiscussionFailure,
) {
  const invalidate = useAwaitedInvalidation(cycleId)
  return useMutation({
    mutationFn: ({ clusterId, status }: StatusWriteInput) =>
      setDiscussionStatus(clusterId, status),
    onError: (error) => {
      onFailure(error, 'status')
    },
    onSettled: () => invalidate(true),
  })
}

export interface AddNoteInput {
  readonly clusterId: string | null
  readonly text: string
}

export interface UpdateNoteInput {
  readonly noteId: string
  readonly text: string
}

/** A note write: add, edit, or delete. One at a time on the board. */
export type NoteWriteInput =
  | ({ readonly kind: 'add' } & AddNoteInput)
  | ({ readonly kind: 'edit' } & UpdateNoteInput)
  | { readonly kind: 'delete'; readonly noteId: string }

export function useNoteWrite(cycleId: string, onFailure: DiscussionFailure) {
  const invalidate = useAwaitedInvalidation(cycleId)
  return useMutation({
    mutationFn: async (input: NoteWriteInput): Promise<void> => {
      switch (input.kind) {
        case 'add':
          await addNote(cycleId, input.clusterId, input.text)
          return
        case 'edit':
          await updateNote(input.noteId, input.text)
          return
        case 'delete':
          await deleteNote(input.noteId)
          return
      }
    },
    onError: (error, input) => {
      onFailure(error, input.kind)
    },
    onSettled: () => invalidate(false),
  })
}
