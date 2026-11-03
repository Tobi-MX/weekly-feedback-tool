import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import type { CycleBoard, MyVote } from './boardApi'
import { cycleBoardQueryKey } from './boardKeys'
import type { VoteOperation } from './voteErrors'
import { castVote, removeVote } from './votesApi'

/**
 * One vote write as it was sent. `myVotes` and `votesRemaining` are the
 * caller's numbers on the board that was on screen when it was sent: the
 * base the overlay applies to, so a refetch that lands while the write is
 * pending (and may already hold the new vote) never counts it twice.
 */
export interface VoteWrite {
  readonly operation: VoteOperation
  readonly clusterId: string
  /** The cluster's name when the write was sent, for the announcement. */
  readonly clusterName: string
  readonly myVotes: readonly MyVote[]
  readonly votesRemaining: number
}

/** The caller's own vote numbers as the view shows them. */
export interface ShownVotes {
  /** The caller's own votes on a cluster: 0 when it has none. */
  readonly countOf: (clusterId: string) => number
  readonly votesRemaining: number
}

function countIn(myVotes: readonly MyVote[], clusterId: string): number {
  return myVotes.find((vote) => vote.clusterId === clusterId)?.voteCount ?? 0
}

/**
 * The numbers to show: the server board's, or, while a write is pending, the
 * write's base with that one vote added or removed. Never cached anywhere.
 */
export function shownVotes(
  board: Pick<CycleBoard, 'myVotes' | 'votesRemaining'>,
  pending: VoteWrite | null,
): ShownVotes {
  if (pending === null) {
    return {
      countOf: (clusterId) => countIn(board.myVotes, clusterId),
      votesRemaining: board.votesRemaining,
    }
  }
  const delta = pending.operation === 'add' ? 1 : -1
  return {
    countOf: (clusterId) =>
      countIn(pending.myVotes, clusterId) +
      (clusterId === pending.clusterId ? delta : 0),
    votesRemaining: pending.votesRemaining - delta,
  }
}

/**
 * The vote write (#23), modelled on `useMoveCard` (#18). The board is never
 * edited in the cache: the view draws `pendingWrite` (the mutation's
 * variables) over the server board. `onSettled` returns the board
 * invalidation, so the mutation stays pending, and the overlay stays, until
 * the refetched board is in. A failed write drops its overlay at once
 * (`onFailure` runs before the refetch). The callbacks live on the mutation,
 * so a write that settles after the view has unmounted still shows its
 * toast.
 */
export function useVoteWrite(
  cycleId: string,
  onFailure: (error: unknown, write: VoteWrite) => void,
) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [failed, setFailed] = useState<VoteWrite | null>(null)

  const mutation = useMutation({
    mutationFn: (write: VoteWrite) =>
      write.operation === 'add'
        ? castVote(cycleId, write.clusterId)
        : removeVote(cycleId, write.clusterId),
    onError: (error, write) => {
      setFailed(write)
      onFailure(error, write)
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: cycleBoardQueryKey(userId, cycleId),
      }),
  })

  const variables = mutation.isPending ? mutation.variables : undefined
  const pendingWrite =
    variables !== undefined && variables !== failed ? variables : null

  return {
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    pendingWrite,
  }
}
