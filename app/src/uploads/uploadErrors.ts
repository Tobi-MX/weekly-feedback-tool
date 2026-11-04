/**
 * The stable codes of the meeting upload RPCs and the Storage upload (#28).
 * Anything else (a network failure, a reply that does not match the strict
 * schema) is `unknown`. Nothing else from a Postgres or Storage error is
 * ever kept, shown, or logged.
 */
export const UPLOAD_ERROR_CODES = [
  'not_project_member',
  'not_project_facilitator',
  'cycle_not_discussing',
  'invalid_upload_kind',
  'invalid_upload_file',
  'upload_too_large',
  'invalid_transcript_text',
  'upload_limit_reached',
  'upload_not_found',
  'upload_file_missing',
  // The Storage upload itself failed (client-side code).
  'upload_failed',
] as const

export type UploadErrorCode = (typeof UPLOAD_ERROR_CODES)[number] | 'unknown'

export const NOT_FACILITATOR_UPLOAD_MESSAGE =
  'Only the facilitator can upload the meeting record.'
export const UPLOAD_STAGE_MESSAGE =
  'The meeting record can be uploaded once the retrospective reaches the Discuss stage.'

/**
 * The copy for every code. `null` means no message: the page switches to its
 * not-found state instead. A `Record` over every code, so a code without copy
 * fails the typecheck.
 */
export const UPLOAD_ERROR_MESSAGES: Record<UploadErrorCode, string | null> = {
  not_project_member: null,
  not_project_facilitator: NOT_FACILITATOR_UPLOAD_MESSAGE,
  cycle_not_discussing: UPLOAD_STAGE_MESSAGE,
  invalid_upload_kind: 'Choose what you are adding.',
  invalid_upload_file: 'This file type or name is not accepted.',
  upload_too_large:
    'The file is too large. Audio and video can be up to 200 MB, transcript files up to 10 MB.',
  invalid_transcript_text:
    'Paste between 1 and 200,000 characters of transcript text.',
  upload_limit_reached: 'This retrospective has reached its upload limit.',
  upload_not_found: 'This upload no longer exists.',
  upload_file_missing: 'The file has not arrived. Try the upload again.',
  upload_failed:
    'The file could not be uploaded. Check your connection and try again.',
  unknown: 'Something went wrong. Try again.',
}

export function uploadErrorMessage(code: UploadErrorCode): string | null {
  return UPLOAD_ERROR_MESSAGES[code]
}

/** An error that carries only a stable code, never the server's text. */
export class UploadApiError extends Error {
  readonly code: UploadErrorCode

  constructor(code: UploadErrorCode) {
    super(code)
    this.name = 'UploadApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to a stable code, else `unknown`. */
export function toUploadErrorCode(
  message: string | null | undefined,
): UploadErrorCode {
  return UPLOAD_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

export function uploadErrorCodeOf(error: unknown): UploadErrorCode {
  return error instanceof UploadApiError ? error.code : 'unknown'
}
