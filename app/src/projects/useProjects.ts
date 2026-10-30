import { useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import {
  createProject,
  fetchProject,
  fetchProjects,
  type CreateProjectInput,
} from './projectsApi'

export const projectsQueryKey = (userId: string | null) =>
  ['projects', userId] as const

export const projectQueryKey = (userId: string | null, projectId: string) =>
  ['project', userId, projectId] as const

/** The list query is scoped by user and disabled until auth has settled. */
export function useProjectsQuery() {
  const { status, user } = useAuth()
  const userId = user?.id ?? null

  return useQuery({
    queryKey: projectsQueryKey(userId),
    queryFn: fetchProjects,
    enabled: status === 'authenticated' && userId !== null,
  })
}

/** The by-id query is scoped by user and id and never runs without both. */
export function useProjectQuery(projectId: string | undefined) {
  const { status, user } = useAuth()
  const userId = user?.id ?? null

  return useQuery({
    queryKey: projectQueryKey(userId, projectId ?? ''),
    queryFn: () => fetchProject(projectId ?? ''),
    enabled:
      status === 'authenticated' && userId !== null && Boolean(projectId),
  })
}

/** The create mutation; the caller owns invalidation and navigation. */
export function useCreateProject() {
  return useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
  })
}
