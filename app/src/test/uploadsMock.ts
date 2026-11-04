import { vi } from 'vitest'
import { UploadApiError } from '../uploads/uploadErrors'
import type {
  CompletedUpload,
  CreatedUpload,
  CycleUploads,
  MeetingFileUpload,
  UploadRequest,
} from '../uploads/uploadsApi'

/**
 * Shared mock for the calls in `src/uploads/uploadsApi.ts` (#28). Every test
 * gets it through `setupTests`, so no test calls the upload RPCs or Storage.
 * By default every call fails with `unknown` until a test configures it.
 */
export const uploadsMock = {
  createMeetingUpload:
    vi.fn<
      (cycleId: string, request: UploadRequest) => Promise<CreatedUpload>
    >(),
  completeMeetingUpload:
    vi.fn<(uploadId: string) => Promise<CompletedUpload>>(),
  fetchCycleUploads: vi.fn<(cycleId: string) => Promise<CycleUploads>>(),
  uploadMeetingFile: vi.fn<(upload: MeetingFileUpload) => Promise<void>>(),

  resetUploadsMock(): void {
    const unknown = () => new UploadApiError('unknown')
    uploadsMock.createMeetingUpload.mockReset().mockRejectedValue(unknown())
    uploadsMock.completeMeetingUpload.mockReset().mockRejectedValue(unknown())
    uploadsMock.fetchCycleUploads.mockReset().mockRejectedValue(unknown())
    uploadsMock.uploadMeetingFile
      .mockReset()
      .mockRejectedValue(new UploadApiError('upload_failed'))
  },
}

export function resetUploadsMock(): void {
  uploadsMock.resetUploadsMock()
}
