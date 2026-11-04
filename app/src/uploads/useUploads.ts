import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import {
  UploadApiError,
  uploadErrorCodeOf,
  type UploadErrorCode,
} from './uploadErrors'
import {
  completeMeetingUpload,
  createMeetingUpload,
  fetchCycleUploads,
  uploadMeetingFile,
} from './uploadsApi'
import type { FileUploadKind, UploadStatus } from './uploadRules'

/** The uploads query's key, scoped by user and cycle id. */
export const uploadsQueryKey = (userId: string | null, cycleId: string) =>
  ['meeting-uploads', userId, cycleId] as const

/**
 * The cycle's uploads (#28). Enabled only for the facilitator, so
 * `get_cycle_uploads` is never called for anyone else. Not live: only the
 * facilitator's own actions change these rows.
 */
export function useCycleUploadsQuery(cycleId: string, enabled: boolean) {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  const ready = status === 'authenticated' && userId !== null

  return useQuery({
    queryKey: uploadsQueryKey(userId, cycleId),
    queryFn: () => fetchCycleUploads(cycleId),
    enabled: ready && enabled,
  })
}

/** A registered file row, kept in memory so a retry reuses it. */
export interface RegisteredFile {
  readonly uploadId: string
  readonly storagePath: string
  readonly mimeType: string
}

/** What the facilitator asks for. */
export type AddUploadInput =
  | {
      readonly type: 'file'
      readonly kind: FileUploadKind
      readonly file: File
    }
  | { readonly type: 'text'; readonly text: string }
  /** The upload or completion failed: repeat both for the same row. */
  | {
      readonly type: 'retry'
      readonly registered: RegisteredFile
      readonly file: File
    }
  /** Check again: completion only. */
  | { readonly type: 'check'; readonly uploadId: string }

export interface AddUploadResult {
  readonly uploadId: string
  readonly status: UploadStatus
}

/**
 * A failure after the row was registered. The page keeps `registered` so
 * Retry upload repeats the signed URL, upload and completion for the same
 * row, and never registers a second one.
 */
export class RegisteredUploadError extends UploadApiError {
  readonly registered: RegisteredFile

  constructor(code: UploadErrorCode, registered: RegisteredFile) {
    super(code)
    this.name = 'RegisteredUploadError'
    this.registered = registered
  }
}

async function sendFile(
  registered: RegisteredFile,
  file: File,
): Promise<AddUploadResult> {
  try {
    await uploadMeetingFile({
      storagePath: registered.storagePath,
      mimeType: registered.mimeType,
      file,
    })
    const completed = await completeMeetingUpload(registered.uploadId)
    return { uploadId: completed.uploadId, status: completed.status }
  } catch (error) {
    throw new RegisteredUploadError(uploadErrorCodeOf(error), registered)
  }
}

/**
 * Register -> upload -> complete (register only for pasted text), a retry
 * of the same row, or a completion check. It settles only after the
 * uploads re-read it starts has finished; nothing is written to the cache.
 * The sequence runs to the end even when the page unmounts.
 */
export function useAddMeetingUpload(cycleId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  return useMutation({
    mutationFn: async (input: AddUploadInput): Promise<AddUploadResult> => {
      switch (input.type) {
        case 'text': {
          const created = await createMeetingUpload(cycleId, {
            kind: 'transcript_text',
            pasted_text: input.text,
          })
          return { uploadId: created.uploadId, status: created.status }
        }
        case 'file': {
          const created = await createMeetingUpload(cycleId, {
            kind: input.kind,
            filename: input.file.name,
            size: input.file.size,
          })
          if (created.storagePath === null || created.mimeType === null) {
            throw new UploadApiError('unknown')
          }
          return sendFile(
            {
              uploadId: created.uploadId,
              storagePath: created.storagePath,
              mimeType: created.mimeType,
            },
            input.file,
          )
        }
        case 'retry':
          return sendFile(input.registered, input.file)
        case 'check': {
          const completed = await completeMeetingUpload(input.uploadId)
          return { uploadId: completed.uploadId, status: completed.status }
        }
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: uploadsQueryKey(userId, cycleId),
      }),
  })
}
