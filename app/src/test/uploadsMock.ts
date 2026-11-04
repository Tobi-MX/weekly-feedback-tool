import { vi } from 'vitest'
import type { TranscriptSegment } from '../uploads/transcriptParser'
import { UploadApiError } from '../uploads/uploadErrors'
import type {
  CompletedUpload,
  CreatedUpload,
  CycleUploads,
  MeetingFileUpload,
  StoredTranscript,
  UploadRequest,
} from '../uploads/uploadsApi'
import type { TranscriptRejectReason } from '../uploads/uploadRules'

/**
 * Shared mock for the calls in `src/uploads/uploadsApi.ts` (#28, #29). Every
 * test gets it through `setupTests`, so no test calls the upload RPCs,
 * Storage, or `fetch`. `downloadTranscriptFile` stands for the signed URL
 * (`createSignedUrl`) and the `fetch` of it; `uploadsApi.test.ts` covers
 * those two calls. By default every call fails until a test configures it.
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
  storeTranscript:
    vi.fn<
      (
        uploadId: string,
        text: string,
        segments: readonly TranscriptSegment[],
      ) => Promise<StoredTranscript>
    >(),
  rejectTranscriptUpload:
    vi.fn<
      (
        uploadId: string,
        reason: TranscriptRejectReason,
      ) => Promise<CompletedUpload>
    >(),
  fetchPastedTranscriptText: vi.fn<(uploadId: string) => Promise<string>>(),
  downloadTranscriptFile: vi.fn<(storagePath: string) => Promise<Uint8Array>>(),

  resetUploadsMock(): void {
    const unknown = () => new UploadApiError('unknown')
    uploadsMock.createMeetingUpload.mockReset().mockRejectedValue(unknown())
    uploadsMock.completeMeetingUpload.mockReset().mockRejectedValue(unknown())
    uploadsMock.fetchCycleUploads.mockReset().mockRejectedValue(unknown())
    uploadsMock.uploadMeetingFile
      .mockReset()
      .mockRejectedValue(new UploadApiError('upload_failed'))
    uploadsMock.storeTranscript.mockReset().mockRejectedValue(unknown())
    uploadsMock.rejectTranscriptUpload.mockReset().mockRejectedValue(unknown())
    uploadsMock.fetchPastedTranscriptText
      .mockReset()
      .mockRejectedValue(unknown())
    uploadsMock.downloadTranscriptFile
      .mockReset()
      .mockRejectedValue(new UploadApiError('transcript_download_failed'))
  },
}

export function resetUploadsMock(): void {
  uploadsMock.resetUploadsMock()
}
