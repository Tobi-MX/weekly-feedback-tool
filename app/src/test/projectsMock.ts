import { vi } from 'vitest'
import type {
  CreateProjectInput,
  CreatedProject,
  ProjectSummary,
} from '../projects/projectsApi'

/**
 * Shared mock for `src/projects/projectsApi.ts`. Every test gets it through
 * `setupTests`, so no test opens a network connection for project data.
 */
export const projectsMock = {
  fetchProjects: vi.fn<() => Promise<ProjectSummary[]>>(),
  fetchProject: vi.fn<(projectId: string) => Promise<ProjectSummary | null>>(),
  createProject:
    vi.fn<(input: CreateProjectInput) => Promise<CreatedProject>>(),

  resetProjectsMock(): void {
    projectsMock.fetchProjects.mockReset().mockResolvedValue([])
    projectsMock.fetchProject.mockReset().mockResolvedValue(null)
    projectsMock.createProject
      .mockReset()
      .mockRejectedValue(new Error('Could not create the project.'))
  },
}

export function resetProjectsMock(): void {
  projectsMock.resetProjectsMock()
}
