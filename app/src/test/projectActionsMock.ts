import { vi } from 'vitest'
import type {
  ProjectActionFilters,
  ProjectActions,
} from '../projects/projectActionsApi'

/** An empty answer that echoes the request, as the server would. */
export function emptyProjectActions(
  projectId: string,
  filters: ProjectActionFilters,
): ProjectActions {
  return {
    projectId,
    status: filters.status,
    mineOnly: filters.mineOnly,
    openCount: 0,
    doneCount: 0,
    open: [],
    done: [],
  }
}

/**
 * Shared mock for `src/projects/projectActionsApi.ts` (#27). Every test gets
 * it through `setupTests`, so no test calls `get_project_actions`. By default
 * it resolves to empty lists, so project page tests that do not care about
 * action items are unaffected.
 */
export const projectActionsMock = {
  fetchProjectActions:
    vi.fn<
      (
        projectId: string,
        filters: ProjectActionFilters,
      ) => Promise<ProjectActions>
    >(),

  resetProjectActionsMock(): void {
    projectActionsMock.fetchProjectActions
      .mockReset()
      .mockImplementation((projectId, filters) =>
        Promise.resolve(emptyProjectActions(projectId, filters)),
      )
  },
}

export function resetProjectActionsMock(): void {
  projectActionsMock.resetProjectActionsMock()
}
