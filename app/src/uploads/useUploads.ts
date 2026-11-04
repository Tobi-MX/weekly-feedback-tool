import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import {
  decodeTranscriptBytes,
  isTranscriptParseError,
  parseTranscript,
  resolveTranscriptFormat,
  type ParsedTranscript,
  type TranscriptFormat,
  type TranscriptParseError,
} from './transcriptParser'
import {
  UploadApiError,
  uploadErrorCodeOf,
  type UploadErrorCode,
} from './uploadErrors'
import {
  completeMeetingUpload,
  createMeetingUpload,
  downloadTranscriptFile,
  fetchCycleUploads,
  fetchPastedTranscriptText,
  rejectTranscriptUpload,
  storeTranscript,
  uploadMeetingFile,
} from './uploadsApi'
import {
  UPLOAD_MIME_TYPES,
  formatForUpload,
  rejectReasonFor,
  type FileUploadKind,
  type UploadStatus,
} from './uploadRules'

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

/**
 * One transcript read (#29): a file is downloaded, decoded and parsed;
 * pasted text is the in-memory parse, or, when the tab lost it, the
 * registered text read back and parsed again.
 */
export type TranscriptSource =
  | {
      readonly type: 'file'
      readonly uploadId: string
      readonly storagePath: string
      readonly mimeType: string | null
    }
  | {
      readonly type: 'text'
      readonly uploadId: string
      readonly parsed: ParsedTranscript | null
    }

/** How a read ended: stored, or refused by the parser and rejected. */
export type TranscriptReadOutcome =
  | {
      readonly type: 'stored'
      readonly status: UploadStatus
      readonly textLength: number
      readonly segmentCount: number
    }
  | {
      readonly type: 'rejected'
      readonly error: TranscriptParseError
      readonly format: TranscriptFormat
    }

/** What the facilitator asks for. */
export type AddUploadInput =
  | {
      readonly type: 'file'
      readonly kind: FileUploadKind
      readonly file: File
      /** A transcript file moves from uploading to reading. */
      readonly onReading?: () => void
    }
  /** Pasted text, parsed before it is registered (#29, decision 10). */
  | {
      readonly type: 'text'
      readonly text: string
      readonly parsed: ParsedTranscript
    }
  /** The upload or completion failed: repeat both for the same row. */
  | {
      readonly type: 'retry'
      readonly registered: RegisteredFile
      readonly file: File
      readonly onReading?: () => void
    }
  /** Check again: completion only. */
  | { readonly type: 'check'; readonly uploadId: string }

export interface AddUploadResult {
  readonly uploadId: string
  readonly status: UploadStatus
  /** The transcript read that followed, for transcript files and text. */
  readonly read: TranscriptReadOutcome | null
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

/**
 * A download, read-back or store failure: the row is still `uploaded`. The
 * page keeps `source` so Read again repeats the read for the same row.
 */
export class TranscriptReadError extends UploadApiError {
  readonly source: TranscriptSource

  constructor(code: UploadErrorCode, source: TranscriptSource) {
    super(code)
    this.name = 'TranscriptReadError'
    this.source = source
  }
}

/**
 * Reads one transcript upload: download -> decode -> parse ->
 * `store_transcript`, or `reject_transcript_upload` when the parser refuses
 * it. A failure along the way leaves the row `uploaded`.
 */
export async function readTranscript(
  source: TranscriptSource,
): Promise<TranscriptReadOutcome> {
  try {
    let result: ParsedTranscript | TranscriptParseError
    let format: TranscriptFormat
    if (source.type === 'file') {
      const bytes = await downloadTranscriptFile(source.storagePath)
      const parseFormat = formatForUpload('transcript_file', source.mimeType)
      const decoded = decodeTranscriptBytes(bytes)
      if (typeof decoded === 'string') {
        format = resolveTranscriptFormat(decoded, parseFormat)
        result = parseTranscript(decoded, parseFormat)
      } else {
        format = resolveTranscriptFormat('', parseFormat)
        result = decoded
      }
    } else if (source.parsed !== null) {
      format = source.parsed.format
      result = source.parsed
    } else {
      const text = await fetchPastedTranscriptText(source.uploadId)
      format = resolveTranscriptFormat(text, 'auto')
      result = parseTranscript(text, 'auto')
    }
    if (isTranscriptParseError(result)) {
      await rejectTranscriptUpload(
        source.uploadId,
        rejectReasonFor(result.code),
      )
      return { type: 'rejected', error: result, format }
    }
    const stored = await storeTranscript(
      source.uploadId,
      result.text,
      result.segments,
    )
    return {
      type: 'stored',
      status: stored.status,
      textLength: stored.textLength,
      segmentCount: stored.segmentCount,
    }
  } catch (error) {
    throw new TranscriptReadError(uploadErrorCodeOf(error), source)
  }
}

async function sendFile(
  registered: RegisteredFile,
  file: File,
  onReading: (() => void) | undefined,
): Promise<AddUploadResult> {
  let status: UploadStatus
  try {
    await uploadMeetingFile({
      storagePath: registered.storagePath,
      mimeType: registered.mimeType,
      file,
    })
    const completed = await completeMeetingUpload(registered.uploadId)
    status = completed.status
  } catch (error) {
    throw new RegisteredUploadError(uploadErrorCodeOf(error), registered)
  }
  const isTranscript = Object.values(
    UPLOAD_MIME_TYPES.transcript_file,
  ).includes(registered.mimeType)
  if (!isTranscript || status !== 'uploaded') {
    return { uploadId: registered.uploadId, status, read: null }
  }
  onReading?.()
  const read = await readTranscript({
    type: 'file',
    uploadId: registered.uploadId,
    storagePath: registered.storagePath,
    mimeType: registered.mimeType,
  })
  return {
    uploadId: registered.uploadId,
    status: read.type === 'stored' ? read.status : 'rejected',
    read,
  }
}

/** The awaited re-read every sequence settles on. Nothing edits the cache. */
function useInvalidateUploads(cycleId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  return () =>
    queryClient.invalidateQueries({
      queryKey: uploadsQueryKey(userId, cycleId),
    })
}

/**
 * Register -> upload -> complete, then for a transcript file download ->
 * decode -> parse -> store or reject; parsed pasted text is registered,
 * then stored. Also a retry of the same row, or a completion check. It
 * settles only after the uploads re-read it starts has finished; nothing is
 * written to the cache. The sequence runs to the end even when the page
 * unmounts.
 */
export function useAddMeetingUpload(cycleId: string) {
  const invalidate = useInvalidateUploads(cycleId)
  return useMutation({
    mutationFn: async (input: AddUploadInput): Promise<AddUploadResult> => {
      switch (input.type) {
        case 'text': {
          const created = await createMeetingUpload(cycleId, {
            kind: 'transcript_text',
            pasted_text: input.text,
          })
          const read = await readTranscript({
            type: 'text',
            uploadId: created.uploadId,
            parsed: input.parsed,
          })
          return {
            uploadId: created.uploadId,
            status: read.type === 'stored' ? read.status : 'rejected',
            read,
          }
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
            input.onReading,
          )
        }
        case 'retry':
          return sendFile(input.registered, input.file, input.onReading)
        case 'check': {
          const completed = await completeMeetingUpload(input.uploadId)
          return {
            uploadId: completed.uploadId,
            status: completed.status,
            read: null,
          }
        }
      }
    },
    onSettled: invalidate,
  })
}

/**
 * Read again / Read transcript (#29): one read of an existing `uploaded`
 * transcript row, with the download for a file or
 * `get_pasted_transcript_text` for text. Settles after the awaited re-read.
 */
export function useReadTranscript(cycleId: string) {
  const invalidate = useInvalidateUploads(cycleId)
  return useMutation({
    mutationFn: (source: TranscriptSource) => readTranscript(source),
    onSettled: invalidate,
  })
}
