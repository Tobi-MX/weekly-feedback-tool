import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { UploadApiError, toUploadErrorCode } from './uploadErrors'
import {
  UPLOAD_KINDS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MIME_TYPES,
  UPLOAD_STATUSES,
  isFileKind,
  type FileUploadKind,
  type UploadKind,
  type UploadStatus,
} from './uploadRules'

/** The private bucket for meeting records (#28). */
export const MEETING_MEDIA_BUCKET = 'meeting-media'

/** What `create_meeting_upload` returned. Path and type are null for text. */
export interface CreatedUpload {
  readonly uploadId: string
  readonly kind: UploadKind
  readonly status: UploadStatus
  readonly storagePath: string | null
  readonly mimeType: string | null
}

/** What `complete_meeting_upload` returned. */
export interface CompletedUpload {
  readonly uploadId: string
  readonly status: UploadStatus
  readonly errorCode: string | null
}

/** One upload as `get_cycle_uploads` lists it. */
export interface MeetingUpload {
  readonly uploadId: string
  readonly kind: UploadKind
  readonly status: UploadStatus
  readonly originalFilename: string | null
  readonly mimeType: string | null
  readonly sizeBytes: number | null
  /** Characters of pasted text; null for files. */
  readonly textLength: number | null
  readonly storagePath: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly createdAt: string
  readonly uploadedAt: string | null
  readonly updatedAt: string
}

export interface CycleUploads {
  readonly cycleId: string
  readonly uploads: readonly MeetingUpload[]
}

/** A file upload or pasted text, as the form submits it. */
export type UploadRequest =
  | {
      readonly kind: FileUploadKind
      readonly filename: string
      readonly size: number
    }
  | { readonly kind: 'transcript_text'; readonly pasted_text: string }

const timestamp = z.iso.datetime({ offset: true })
const errorCode = z
  .string()
  .regex(/^[a-z_]{1,64}$/)
  .nullable()

/** The kind/field consistency of the table CHECKs. */
function fileFieldsConsistent(row: {
  readonly kind: UploadKind
  readonly storage_path: string | null
  readonly mime_type: string | null
}): boolean {
  if (!isFileKind(row.kind)) {
    return row.storage_path === null && row.mime_type === null
  }
  return (
    row.storage_path !== null &&
    row.mime_type !== null &&
    Object.values(UPLOAD_MIME_TYPES[row.kind]).includes(row.mime_type)
  )
}

const createdSchema = z
  .object({
    upload_id: z.string(),
    kind: z.enum(UPLOAD_KINDS),
    status: z.enum(UPLOAD_STATUSES),
    storage_path: z.string().nullable(),
    mime_type: z.string().nullable(),
  })
  .strict()
  .refine(fileFieldsConsistent)
  .refine((row) =>
    isFileKind(row.kind)
      ? row.status === 'pending_upload'
      : row.status === 'uploaded',
  )

const completedSchema = z
  .object({
    upload_id: z.string(),
    status: z.enum(UPLOAD_STATUSES),
    error_code: errorCode,
  })
  .strict()

const uploadSchema = z
  .object({
    upload_id: z.string(),
    kind: z.enum(UPLOAD_KINDS),
    status: z.enum(UPLOAD_STATUSES),
    original_filename: z.string().min(1).nullable(),
    mime_type: z.string().nullable(),
    size_bytes: z.number().int().positive().nullable(),
    text_length: z.number().int().positive().nullable(),
    storage_path: z.string().nullable(),
    error_code: errorCode,
    error_message: z.string().nullable(),
    created_at: timestamp,
    uploaded_at: timestamp.nullable(),
    updated_at: timestamp,
  })
  .strict()
  .refine(fileFieldsConsistent)
  .refine((row) =>
    isFileKind(row.kind)
      ? row.original_filename !== null &&
        row.size_bytes !== null &&
        row.size_bytes <= UPLOAD_MAX_BYTES[row.kind] &&
        row.text_length === null
      : row.original_filename === null &&
        row.size_bytes === null &&
        row.text_length !== null &&
        row.status !== 'pending_upload',
  )
  .refine(
    (row) =>
      (row.status === 'pending_upload' || row.status === 'rejected') ===
      (row.uploaded_at === null),
  )

const uploadsSchema = z
  .object({
    cycle_id: z.string(),
    uploads: z.array(uploadSchema),
  })
  .strict()

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/**
 * Calls one upload RPC. A missing client, a thrown call, and any error
 * become an `UploadApiError` carrying only a stable code.
 */
async function callRpc(
  fn: string,
  args: Record<string, string | number | null>,
): Promise<unknown> {
  if (!supabase) {
    throw new UploadApiError('unknown')
  }
  let result: DbResult
  try {
    result = await supabase.rpc(fn, args)
  } catch {
    throw new UploadApiError('unknown')
  }
  if (result.error) {
    throw new UploadApiError(toUploadErrorCode(result.error.message))
  }
  return result.data
}

function oneRow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = z.array(schema).length(1).safeParse(data)
  if (!parsed.success) {
    throw new UploadApiError('unknown')
  }
  return parsed.data[0]
}

/** Registers a file upload or saves pasted text. */
export async function createMeetingUpload(
  cycleId: string,
  request: UploadRequest,
): Promise<CreatedUpload> {
  const isText = request.kind === 'transcript_text'
  const data = await callRpc('create_meeting_upload', {
    p_cycle_id: cycleId,
    p_kind: request.kind,
    p_filename: isText ? null : request.filename,
    p_size_bytes: isText ? null : request.size,
    p_pasted_text: isText ? request.pasted_text : null,
  })
  const row = oneRow(createdSchema, data)
  if (row.kind !== request.kind) {
    throw new UploadApiError('unknown')
  }
  return {
    uploadId: row.upload_id,
    kind: row.kind,
    status: row.status,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
  }
}

/** Checks the stored object and returns the upload's status. */
export async function completeMeetingUpload(
  uploadId: string,
): Promise<CompletedUpload> {
  const data = await callRpc('complete_meeting_upload', {
    p_upload_id: uploadId,
  })
  const row = oneRow(completedSchema, data)
  if (row.upload_id !== uploadId) {
    throw new UploadApiError('unknown')
  }
  return {
    uploadId: row.upload_id,
    status: row.status,
    errorCode: row.error_code,
  }
}

/** The cycle's uploads, newest first. Facilitator only. */
export async function fetchCycleUploads(
  cycleId: string,
): Promise<CycleUploads> {
  const data = await callRpc('get_cycle_uploads', { p_cycle_id: cycleId })
  const parsed = uploadsSchema.safeParse(data)
  if (!parsed.success || parsed.data.cycle_id !== cycleId) {
    throw new UploadApiError('unknown')
  }
  return {
    cycleId: parsed.data.cycle_id,
    uploads: parsed.data.uploads.map((row) => ({
      uploadId: row.upload_id,
      kind: row.kind,
      status: row.status,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      textLength: row.text_length,
      storagePath: row.storage_path,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      uploadedAt: row.uploaded_at,
      updatedAt: row.updated_at,
    })),
  }
}

export interface MeetingFileUpload {
  readonly storagePath: string
  readonly mimeType: string
  readonly file: Blob
}

/** The HTTP status a Storage error carries (in `statusCode` or `status`). */
function storageStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const { statusCode, status } = error as {
    readonly statusCode?: unknown
    readonly status?: unknown
  }
  const fromCode =
    typeof statusCode === 'string' && /^\d{3}$/.test(statusCode)
      ? Number(statusCode)
      : null
  if (fromCode !== null) {
    return fromCode
  }
  return typeof status === 'number' ? status : null
}

/** 409 means the object is already there; completion will verify it. */
function failureCode(
  error: unknown,
): 'exists' | 'upload_too_large' | 'upload_failed' {
  const status = storageStatus(error)
  if (status === 409) {
    return 'exists'
  }
  if (status === 413) {
    return 'upload_too_large'
  }
  return 'upload_failed'
}

/**
 * Uploads the file straight to Storage through a signed upload URL for
 * exactly the registered path. Storage allows it only under the
 * facilitator-only INSERT policy. The token never leaves this function: it
 * is not returned, cached, logged, or put in a URL or browser storage.
 */
export async function uploadMeetingFile({
  storagePath,
  mimeType,
  file,
}: MeetingFileUpload): Promise<void> {
  if (!supabase) {
    throw new UploadApiError('upload_failed')
  }
  const bucket = supabase.storage.from(MEETING_MEDIA_BUCKET)
  try {
    const signed = await bucket.createSignedUploadUrl(storagePath)
    if (signed.error) {
      const code = failureCode(signed.error)
      if (code === 'exists') {
        return
      }
      throw new UploadApiError(code)
    }
    const uploaded = await bucket.uploadToSignedUrl(
      storagePath,
      signed.data.token,
      new Blob([file], { type: mimeType }),
      { contentType: mimeType },
    )
    if (uploaded.error) {
      const code = failureCode(uploaded.error)
      if (code === 'exists') {
        return
      }
      throw new UploadApiError(code)
    }
  } catch (error) {
    if (error instanceof UploadApiError) {
      throw error
    }
    throw new UploadApiError('upload_failed')
  }
}
