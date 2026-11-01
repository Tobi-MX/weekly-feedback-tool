import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { cycleBoardQueryKey } from './boardKeys'
import { createCluster, deleteCluster, renameCluster } from './clustersApi'

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
