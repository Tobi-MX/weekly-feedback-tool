import { vi } from 'vitest'
import type {
  CreatedInvite,
  JoinProjectResult,
  ProjectInvite,
  ProjectMember,
} from '../projects/membersApi'
import { MembersApiError } from '../projects/membersErrors'

/**
 * Shared mock for `src/projects/membersApi.ts`. Every test gets it through
 * `setupTests`, so no test opens a network connection for membership data.
 */
export const membersMock = {
  fetchProjectMembers:
    vi.fn<(projectId: string) => Promise<ProjectMember[] | null>>(),
  fetchProjectInvite:
    vi.fn<(projectId: string) => Promise<ProjectInvite | null>>(),
  createProjectInvite: vi.fn<(projectId: string) => Promise<CreatedInvite>>(),
  revokeProjectInvite: vi.fn<(projectId: string) => Promise<void>>(),
  joinProject: vi.fn<(token: string) => Promise<JoinProjectResult>>(),
  transferFacilitator:
    vi.fn<(projectId: string, userId: string) => Promise<void>>(),

  resetMembersMock(): void {
    membersMock.fetchProjectMembers.mockReset().mockResolvedValue(null)
    membersMock.fetchProjectInvite.mockReset().mockResolvedValue(null)
    membersMock.createProjectInvite
      .mockReset()
      .mockRejectedValue(new MembersApiError('unknown'))
    membersMock.revokeProjectInvite
      .mockReset()
      .mockRejectedValue(new MembersApiError('unknown'))
    membersMock.joinProject
      .mockReset()
      .mockRejectedValue(new MembersApiError('unknown'))
    membersMock.transferFacilitator
      .mockReset()
      .mockRejectedValue(new MembersApiError('unknown'))
  },
}

export function resetMembersMock(): void {
  membersMock.resetMembersMock()
}
