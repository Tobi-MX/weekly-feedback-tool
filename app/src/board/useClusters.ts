import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import type { CycleBoard } from './boardApi'
import { cycleBoardQueryKey } from './boardKeys'
import type { CardMove } from './cardMove'
import {
  createCluster,
  deleteCluster,
  moveCard,
  renameCluster,
} from './clustersApi'

/**
 * Re-reads the board after a cluster write, whether it succeeded or failed.
 * Nothing is written into the cache: the board shows only what the server
 * returns.
 */
function useInvalidateBoard(cycleId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  return () => {
    void queryClient.invalidateQueries({
      queryKey: cycleBoardQueryKey(userId, cycleId),
    })
  }
}

export function useCreateCluster(cycleId: string) {
  const invalidate = useInvalidateBoard(cycleId)
  return useMutation({
    mutationFn: (name: string) => createCluster(cycleId, name),
    onSettled: invalidate,
  })
}

export interface RenameClusterInput {
  readonly clusterId: string
  readonly name: string
}

export function useRenameCluster(cycleId: string) {
  const invalidate = useInvalidateBoard(cycleId)
  return useMutation({
    mutationFn: ({ clusterId, name }: RenameClusterInput) =>
      renameCluster(clusterId, name),
    onSettled: invalidate,
  })
}

export function useDeleteCluster(cycleId: string) {
  const invalidate = useInvalidateBoard(cycleId)
  return useMutation({
    mutationFn: (clusterId: string) => deleteCluster(clusterId),
    onSettled: invalidate,
  })
}

/**
 * The one optimistic board write (#18). The board is never edited in the
 * cache: the cluster view applies `pendingMove` (the mutation's variables) on
 * top of the server board. `onSettled` returns the board invalidation, so the
 * mutation stays pending, and the overlay stays, until the refetched board is
 * in. A failed move drops its overlay at once (`onFailure` runs before the
 * refetch), so the card returns to its server place.
 */
export function useMoveCard(
  cycleId: string,
  onFailure: (error: unknown, move: CardMove) => void,
) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [failed, setFailed] = useState<CardMove | null>(null)

  const mutation = useMutation({
    mutationFn: (move: CardMove) =>
      moveCard(move.cardId, move.clusterId, move.position),
    onError: (error, move) => {
      setFailed(move)
      onFailure(error, move)
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: cycleBoardQueryKey(userId, cycleId),
      }),
  })

  const variables = mutation.isPending ? mutation.variables : undefined
  const pendingMove =
    variables !== undefined && variables !== failed ? variables : null

  return {
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    pendingMove,
    /** The board as the cache holds it now: the server's, no overlay. */
    serverBoard: (): CycleBoard | null =>
      queryClient.getQueryData<CycleBoard | null>(
        cycleBoardQueryKey(userId, cycleId),
      ) ?? null,
  }
}
