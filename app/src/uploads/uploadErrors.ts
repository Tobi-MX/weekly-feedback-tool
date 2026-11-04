import type {
  TranscriptFormat,
  TranscriptParseError,
  TranscriptParseErrorCode,
} from './transcriptParser'
import type { TranscriptRejectReason } from './uploadRules'

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
  // #29: store_transcript, reject_transcript_upload and
  // get_pasted_transcript_text.
  'upload_not_transcript',
  'upload_not_ready',
  'transcript_already_stored',
  'invalid_transcript',
  'invalid_reject_reason',
  // The transcript file could not be downloaded (client-side code, #29).
  'transcript_download_failed',
] as const

export type UploadErrorCode = (typeof UPLOAD_ERROR_CODES)[number] | 'unknown'

const UNKNOWN_MESSAGE = 'Something went wrong. Try again.'

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
  upload_not_transcript: 'This upload is not a transcript.',
  upload_not_ready: 'This upload cannot be read now.',
  transcript_already_stored:
    'A different transcript is already stored for this upload.',
  invalid_transcript:
    'The transcript could not be saved. Add it again as a new upload.',
  invalid_reject_reason: UNKNOWN_MESSAGE,
  transcript_download_failed:
    'The transcript file could not be downloaded. Check your connection and try again.',
  unknown: UNKNOWN_MESSAGE,
}

/**
 * The parser's copy (#29). Codes with a line number get a `Line {n}: `
 * prefix; their copy starts in lower case.
 */
export const TRANSCRIPT_PARSE_MESSAGES: Record<
  TranscriptParseErrorCode,
  string
> = {
  bad_encoding:
    'The file is not UTF-8 or UTF-16 text. Save it as UTF-8 and add it again.',
  not_text: 'This does not look like a text file.',
  empty: 'The transcript is empty.',
  missing_header: 'A VTT file must start with WEBVTT.',
  bad_timing_line: 'expected a timing line like 00:01:02.500 --> 00:01:05.000.',
  bad_timestamp: 'a timestamp is not valid.',
  end_before_start: 'the cue ends before it starts.',
  out_of_order: 'the cue starts before the previous cue.',
  missing_blank_line: 'a blank line is missing before this cue.',
  no_cues: 'The file has no cues with text.',
  too_long: 'The transcript is longer than 200,000 characters.',
  too_many_segments: 'The transcript has more than 20,000 cues.',
}

export const SRT_BAD_TIMING_LINE_MESSAGE =
  'expected a timing line like 00:01:02,500 --> 00:01:05,000.'

/** The copy for a parse error, with its line, in the format it was read as. */
export function transcriptParseMessage(
  error: TranscriptParseError,
  format: TranscriptFormat,
): string {
  const copy =
    error.code === 'bad_timing_line' && format === 'srt'
      ? SRT_BAD_TIMING_LINE_MESSAGE
      : TRANSCRIPT_PARSE_MESSAGES[error.code]
  return error.line === null ? copy : `Line ${error.line}: ${copy}`
}

/** Why a transcript upload was rejected, by its `error_code` (#29). */
export const TRANSCRIPT_REJECTED_REASONS: Record<
  TranscriptRejectReason,
  string
> = {
  transcript_bad_encoding:
    'The file is not UTF-8 or UTF-16 text. Save it as UTF-8 and add it again as a new upload.',
  transcript_not_text:
    'The file is not a text file. Add the right file as a new upload.',
  transcript_empty: 'The file is empty. Add the right file as a new upload.',
  transcript_malformed:
    "The file's cues or timestamps are not valid. Fix the file and add it again as a new upload.",
  transcript_no_cues:
    'The file has no cues with text. Add the right file as a new upload.',
  transcript_too_long: 'The transcript is longer than 200,000 characters.',
  transcript_too_many_segments: 'The transcript has more than 20,000 cues.',
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
