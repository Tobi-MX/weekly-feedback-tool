import { vi } from 'vitest'
import type { CycleDiscussion, DiscussionStatus } from '../board/discussionApi'
import { DiscussionApiError } from '../board/discussionErrors'

/**
 * Shared mock for the calls in `src/board/discussionApi.ts` (#25). Every test
 * gets it through `setupTests`, so no test calls `get_cycle_discussion` or a
 * discussion write. By default every call fails with `unknown` until a test
 * configures it.
 */
export const discussionMock = {
  fetchDiscussion: vi.fn<(cycleId: string) => Promise<CycleDiscussion>>(),
  setDiscussionStatus:
    vi.fn<(clusterId: string, status: DiscussionStatus) => Promise<void>>(),
  addNote:
    vi.fn<
      (
        cycleId: string,
        clusterId: string | null,
        text: string,
      ) => Promise<string>
    >(),
  updateNote: vi.fn<(noteId: string, text: string) => Promise<void>>(),
  deleteNote: vi.fn<(noteId: string) => Promise<void>>(),

  resetDiscussionMock(): void {
    const unknown = () => new DiscussionApiError('unknown')
    discussionMock.fetchDiscussion.mockReset().mockRejectedValue(unknown())
    discussionMock.setDiscussionStatus.mockReset().mockRejectedValue(unknown())
    discussionMock.addNote.mockReset().mockRejectedValue(unknown())
    discussionMock.updateNote.mockReset().mockRejectedValue(unknown())
    discussionMock.deleteNote.mockReset().mockRejectedValue(unknown())
  },
}

export function resetDiscussionMock(): void {
  discussionMock.resetDiscussionMock()
}
