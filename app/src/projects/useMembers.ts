import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import {
  createProjectInvite,
  fetchProjectInvite,
  fetchProjectMembers,
  joinProject,
  revokeProjectInvite,
  transferFacilitator,
} from './membersApi'
import { projectQueryKey, projectsQueryKey } from './useProjects'

export const projectMembersQueryKey = (
  userId: string | null,
  projectId: string,
) => ['project-members', userId, projectId] as const

export const projectInviteQueryKey = (
  userId: string | null,
  projectId: string,
) => ['project-invite', userId, projectId] as const

function useUserId() {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  return { userId, ready: status === 'authenticated' && userId !== null }
}

/** Members of one project, scoped by user and project id. */
export function useProjectMembersQuery(projectId: string | undefined) {
  const { userId, ready } = useUserId()

  return useQuery({
    queryKey: projectMembersQueryKey(userId, projectId ?? ''),
    queryFn: () => fetchProjectMembers(projectId ?? ''),
    enabled: ready && Boolean(projectId),
  })
}

/** The owner-only invite. Callers enable it only for the owner. */
export function useProjectInviteQuery(projectId: string, enabled: boolean) {
  const { userId, ready } = useUserId()

  return useQuery({
    queryKey: projectInviteQueryKey(userId, projectId),
    queryFn: () => fetchProjectInvite(projectId),
    enabled: ready && enabled,
  })
}

/** Creating or rotating the invite refetches it; nothing is optimistic. */
export function useCreateInvite(projectId: string) {
  const { userId } = useUserId()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => createProjectInvite(projectId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: projectInviteQueryKey(userId, projectId),
      }),
  })
}

export function useRevokeInvite(projectId: string) {
  const { userId } = useUserId()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => revokeProjectInvite(projectId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: projectInviteQueryKey(userId, projectId),
      }),
  })
}

export function useTransferFacilitator(projectId: string) {
  const { userId } = useUserId()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (targetUserId: string) =>
      transferFacilitator(projectId, targetUserId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: projectMembersQueryKey(userId, projectId),
      }),
  })
}

/** Joining refreshes the user's project list and the joined project. */
export function useJoinProject() {
  const { userId } = useUserId()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (token: string) => joinProject(token),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectsQueryKey(userId) }),
        queryClient.invalidateQueries({
          queryKey: projectQueryKey(userId, result.projectId),
        }),
      ])
    },
  })
}
