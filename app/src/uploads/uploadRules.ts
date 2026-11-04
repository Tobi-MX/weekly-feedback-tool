/**
 * The only client copy of the meeting upload rules (#28, decisions 3, 4 and
 * 9). The database enforces every one of them in `create_meeting_upload`;
 * these mirror them for faster feedback. Keep both pinned to the same literal
 * table (pgTAP and `uploadRules.test.ts`).
 */

import type {
  TranscriptParseErrorCode,
  TranscriptParseFormat,
} from './transcriptParser'

/** What a meeting record can be. */
export const UPLOAD_KINDS = [
  'audio',
  'video',
  'transcript_file',
  'transcript_text',
] as const
export type UploadKind = (typeof UPLOAD_KINDS)[number]

/** The kinds that are a file uploaded to Storage. */
export type FileUploadKind = Exclude<UploadKind, 'transcript_text'>

export function isFileKind(kind: UploadKind): kind is FileUploadKind {
  return kind !== 'transcript_text'
}

/** Every status a meeting upload can have, #29-#33's included. */
export const UPLOAD_STATUSES = [
  'pending_upload',
  'uploaded',
  'transcribing',
  'extracting',
  'draft_ready',
  'confirmed',
  'published',
  'failed',
  'rejected',
] as const
export type UploadStatus = (typeof UPLOAD_STATUSES)[number]

/** Extension -> canonical MIME type, per file kind (decision 3). */
export const UPLOAD_MIME_TYPES: Readonly<
  Record<FileUploadKind, Readonly<Record<string, string>>>
> = {
  audio: {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
  },
  video: {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
  },
  transcript_file: {
    txt: 'text/plain',
    vtt: 'text/vtt',
    srt: 'application/x-subrip',
  },
}

/** 200 MiB. */
export const MEDIA_MAX_BYTES = 209_715_200
/** 10 MiB. */
export const TRANSCRIPT_FILE_MAX_BYTES = 10_485_760

export const UPLOAD_MAX_BYTES: Readonly<Record<FileUploadKind, number>> = {
  audio: MEDIA_MAX_BYTES,
  video: MEDIA_MAX_BYTES,
  transcript_file: TRANSCRIPT_FILE_MAX_BYTES,
}

/**
 * Pasted transcript text, and a stored transcript's text (#29), in
 * characters (code points).
 */
export const TRANSCRIPT_TEXT_MAX_LENGTH = 200_000
/** Timed segments of a stored transcript (#29). */
export const TRANSCRIPT_MAX_SEGMENTS = 20_000
/** The latest timestamp of a segment: 24 hours, in milliseconds (#29). */
export const TRANSCRIPT_MAX_MS = 86_400_000
/** A file name, after trimming spaces. */
export const FILE_NAME_MAX_LENGTH = 255
/** Uploads per cycle that are neither rejected nor abandoned. */
export const ACTIVE_UPLOADS_LIMIT = 20
/** Rows per cycle, any status. */
export const TOTAL_UPLOADS_LIMIT = 50

/** The `accept` attribute for a file kind's input. */
export function acceptFor(kind: FileUploadKind): string {
  return Object.keys(UPLOAD_MIME_TYPES[kind])
    .map((ext) => `.${ext}`)
    .join(',')
}

/** Code points, like Postgres `char_length`. */
export function codePointLength(text: string): number {
  return [...text].length
}

/**
 * The lowercased extension after the last dot, or null when there is no
 * non-empty base name before it or no extension after it.
 */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) {
    return null
  }
  return name.slice(dot + 1).toLowerCase()
}

// `/`, `\`, C0 and C1 controls, DEL, and the bidi controls U+202A-U+202E and
// U+2066-U+2069 (decision 4). NUL is a C0 control.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARACTERS = /[/\\\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u

export type FileProblem =
  | 'missing'
  | 'empty'
  | 'type'
  | 'too_large'
  | 'name_too_long'
  | 'name_characters'

/** The first rule a chosen file breaks for the kind, or null. */
export function validateUploadFile(
  kind: FileUploadKind,
  file: { readonly name: string; readonly size: number } | null,
): FileProblem | null {
  if (file === null) {
    return 'missing'
  }
  const name = trimSpaces(file.name)
  if (codePointLength(name) > FILE_NAME_MAX_LENGTH) {
    return 'name_too_long'
  }
  if (FORBIDDEN_NAME_CHARACTERS.test(name)) {
    return 'name_characters'
  }
  const ext = fileExtension(name)
  if (ext === null || !Object.hasOwn(UPLOAD_MIME_TYPES[kind], ext)) {
    return 'type'
  }
  if (file.size <= 0) {
    return 'empty'
  }
  if (file.size > UPLOAD_MAX_BYTES[kind]) {
    return 'too_large'
  }
  return null
}

/** The canonical MIME type for a file kind and name, or null. */
export function mimeTypeFor(kind: FileUploadKind, name: string): string | null {
  const ext = fileExtension(trimSpaces(name))
  return ext !== null && Object.hasOwn(UPLOAD_MIME_TYPES[kind], ext)
    ? UPLOAD_MIME_TYPES[kind][ext]
    : null
}

export type TextProblem = 'missing' | 'too_long'

/** The rule pasted text breaks, or null. Blank text counts as missing. */
export function validateTranscriptText(text: string): TextProblem | null {
  if (text.trim() === '') {
    return 'missing'
  }
  if (codePointLength(text) > TRANSCRIPT_TEXT_MAX_LENGTH) {
    return 'too_long'
  }
  return null
}

/** Spaces only, like Postgres `btrim(name)`. */
function trimSpaces(name: string): string {
  return name.replace(/^ +| +$/g, '')
}

/**
 * `512 bytes`, `980.0 KB`, `12.4 MB`: 1,024 steps, one decimal from KB up.
 * The UI says MB for MiB (decision 3).
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`
  }
  const kb = bytes / 1024
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`
  }
  return `${(kb / 1024).toFixed(1)} MB`
}

/** The kinds that hold a transcript (#29). */
export type TranscriptUploadKind = Extract<
  UploadKind,
  'transcript_file' | 'transcript_text'
>

export function isTranscriptKind(
  kind: UploadKind,
): kind is TranscriptUploadKind {
  return kind === 'transcript_file' || kind === 'transcript_text'
}

/**
 * The format a transcript upload is parsed as (#29, decision 2): VTT and SRT
 * files by their type, a plain file and pasted text by their content.
 */
export function formatForUpload(
  kind: TranscriptUploadKind,
  mimeType: string | null,
): TranscriptParseFormat {
  if (kind === 'transcript_file') {
    if (mimeType === 'text/vtt') {
      return 'vtt'
    }
    if (mimeType === 'application/x-subrip') {
      return 'srt'
    }
  }
  return 'auto'
}

/** The `error_code` of a transcript file the parser refused (#29, decision 8). */
export const TRANSCRIPT_REJECT_REASONS = [
  'transcript_bad_encoding',
  'transcript_not_text',
  'transcript_empty',
  'transcript_malformed',
  'transcript_no_cues',
  'transcript_too_long',
  'transcript_too_many_segments',
] as const
export type TranscriptRejectReason = (typeof TRANSCRIPT_REJECT_REASONS)[number]

const REJECT_REASON_BY_PARSE_CODE: Readonly<
  Record<TranscriptParseErrorCode, TranscriptRejectReason>
> = {
  bad_encoding: 'transcript_bad_encoding',
  not_text: 'transcript_not_text',
  empty: 'transcript_empty',
  missing_header: 'transcript_malformed',
  bad_timing_line: 'transcript_malformed',
  bad_timestamp: 'transcript_malformed',
  end_before_start: 'transcript_malformed',
  out_of_order: 'transcript_malformed',
  missing_blank_line: 'transcript_malformed',
  no_cues: 'transcript_no_cues',
  too_long: 'transcript_too_long',
  too_many_segments: 'transcript_too_many_segments',
}

export function rejectReasonFor(
  code: TranscriptParseErrorCode,
): TranscriptRejectReason {
  return REJECT_REASON_BY_PARSE_CODE[code]
}
