import { focusRing } from '@/cards/CardForms'
import { wrapAnywhere } from '@/board/BoardCards'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatProjectDate } from '@/projects/projectDate'
import type { RefObject } from 'react'
import type { MeetingUpload } from './uploadsApi'
import {
  formatFileSize,
  type UploadKind,
  type UploadStatus,
} from './uploadRules'

export const UPLOADS_LOADING_MESSAGE = 'Loading uploads…'
export const UPLOADS_LOAD_ERROR_MESSAGE = 'Could not load the uploads.'
export const UPLOADS_EMPTY_MESSAGE = 'No uploads yet.'
export const PASTED_TEXT_NAME = 'Pasted transcript text'
export const UPLOAD_NOT_FINISHED_MESSAGE = 'Upload not finished.'

export const UPLOAD_KIND_LABELS: Record<UploadKind, string> = {
  audio: 'Audio recording',
  video: 'Video recording',
  transcript_file: 'Transcript file',
  transcript_text: 'Transcript text',
}

export const UPLOAD_STATUS_LABELS: Record<UploadStatus, string> = {
  pending_upload: 'Waiting for the file',
  uploaded: 'Uploaded',
  transcribing: 'Transcribing',
  extracting: 'Extracting outcomes',
  draft_ready: 'Ready for review',
  confirmed: 'Confirmed',
  published: 'Published',
  failed: 'Failed',
  rejected: 'Rejected',
}

/** Why a rejected upload was rejected, by its error code. */
export const REJECTED_REASONS: Readonly<Record<string, string>> = {
  upload_file_mismatch:
    'The uploaded file did not match the file that was registered. Add it again as a new upload.',
  upload_abandoned: 'The file never arrived. Add it again as a new upload.',
}

/** The upload's display name: its file name, or the pasted-text label. */
export function uploadName(upload: MeetingUpload): string {
  return upload.originalFilename ?? PASTED_TEXT_NAME
}

function sizeText(upload: MeetingUpload): string {
  if (upload.sizeBytes !== null) {
    return formatFileSize(upload.sizeBytes)
  }
  const n = upload.textLength ?? 0
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'character' : 'characters'}`
}

interface UploadListProps {
  readonly uploads: readonly MeetingUpload[] | undefined
  readonly isError: boolean
  readonly headingRef: RefObject<HTMLHeadingElement | null>
  /** The row this tab is uploading right now, if any. */
  readonly activeUploadId: string | null
  /** A write is in flight: Check again sends nothing. */
  readonly busy: boolean
  readonly onRetryLoad: () => void
  readonly onCheckAgain: (upload: MeetingUpload) => void
}

/** The cycle's uploads in server order (newest first). */
export function UploadList({
  uploads,
  isError,
  headingRef,
  activeUploadId,
  busy,
  onRetryLoad,
  onCheckAgain,
}: UploadListProps) {
  let body: React.ReactNode
  if (uploads === undefined && isError) {
    body = (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
      >
        <p className="text-sm">{UPLOADS_LOAD_ERROR_MESSAGE}</p>
        <Button type="button" variant="outline" onClick={onRetryLoad}>
          Retry
        </Button>
      </div>
    )
  } else if (uploads === undefined) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {UPLOADS_LOADING_MESSAGE}
      </p>
    )
  } else if (uploads.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">{UPLOADS_EMPTY_MESSAGE}</p>
    )
  } else {
    body = (
      <ul className="min-w-0 space-y-3">
        {uploads.map((upload) => {
          const reason =
            upload.status === 'rejected' && upload.errorCode !== null
              ? REJECTED_REASONS[upload.errorCode]
              : undefined
          const unfinished =
            upload.status === 'pending_upload' &&
            upload.uploadId !== activeUploadId
          return (
            <li
              key={upload.uploadId}
              data-upload-id={upload.uploadId}
              className="min-w-0 space-y-1 rounded-lg border bg-card p-3 text-card-foreground"
            >
              <p className={cn('text-sm font-medium', wrapAnywhere)}>
                {uploadName(upload)}
              </p>
              <p className="text-sm text-muted-foreground">
                {UPLOAD_KIND_LABELS[upload.kind]} · {sizeText(upload)}
              </p>
              <p className="text-sm">
                Status: {UPLOAD_STATUS_LABELS[upload.status]}
              </p>
              {reason !== undefined ? (
                <p className="text-sm">{reason}</p>
              ) : null}
              <p className="text-sm text-muted-foreground">
                Added {formatProjectDate(upload.createdAt)}
              </p>
              {unfinished ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <p className="text-sm">{UPLOAD_NOT_FINISHED_MESSAGE}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-disabled={busy ? 'true' : undefined}
                    className="min-h-6 aria-disabled:opacity-50"
                    onClick={() => {
                      onCheckAgain(upload)
                    }}
                  >
                    Check again
                  </Button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <section aria-labelledby="uploads-heading" className="min-w-0 space-y-3">
      <h2
        id="uploads-heading"
        ref={headingRef}
        tabIndex={-1}
        className={cn('text-xl font-semibold', focusRing)}
      >
        {uploads === undefined ? 'Uploads' : `Uploads (${uploads.length})`}
      </h2>
      {body}
    </section>
  )
}
