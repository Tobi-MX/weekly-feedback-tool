import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

// The shared uploads mock replaces this module's calls; load a fresh copy of
// the real one that sees this file's supabaseClient mock.
vi.resetModules()
const {
  completeMeetingUpload,
  createMeetingUpload,
  fetchCycleUploads,
  uploadMeetingFile,
} = await vi.importActual<typeof import('./uploadsApi')>('./uploadsApi')
const { UploadApiError, uploadErrorCodeOf } =
  await vi.importActual<typeof import('./uploadErrors')>('./uploadErrors')

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const UPLOAD_ID = 'b1000000-0000-4000-8000-000000000001'
const TEXT_ID = 'b1000000-0000-4000-8000-000000000002'
const PATH = `p/${CYCLE_ID}/${UPLOAD_ID}.mp3`
const T = '2026-11-04T12:34:56.123456+00:00'
const TOKEN = 'secret-upload-token'

function createRpcMock(result: DbResult) {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<DbResult>
  >(() => Promise.resolve(result))
  state.client = { rpc }
  return rpc
}

interface StorageResult {
  readonly data: unknown
  readonly error: unknown
}

function createStorageMock(
  signed: StorageResult,
  uploaded: StorageResult = { data: { path: PATH }, error: null },
) {
  const createSignedUploadUrl = vi.fn(() => Promise.resolve(signed))
  const uploadToSignedUrl = vi.fn(() => Promise.resolve(uploaded))
  const from = vi.fn(() => ({ createSignedUploadUrl, uploadToSignedUrl }))
  state.client = { storage: { from } }
  return { from, createSignedUploadUrl, uploadToSignedUrl }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(UploadApiError)
  return uploadErrorCodeOf(error)
}

function fileItem(overrides: Record<string, unknown> = {}) {
  return {
    upload_id: UPLOAD_ID,
    kind: 'audio',
    status: 'uploaded',
    original_filename: 'standup.MP3',
    mime_type: 'audio/mpeg',
    size_bytes: 16,
    text_length: null,
    storage_path: PATH,
    error_code: null,
    error_message: null,
    created_at: T,
    uploaded_at: T,
    updated_at: T,
    ...overrides,
  }
}

function textItem(overrides: Record<string, unknown> = {}) {
  return fileItem({
    upload_id: TEXT_ID,
    kind: 'transcript_text',
    original_filename: null,
    mime_type: null,
    size_bytes: null,
    text_length: 12,
    storage_path: null,
    ...overrides,
  })
}

function withoutKey(
  row: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([name]) => name !== key),
  )
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = []

beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (method) => vi.spyOn(console, method),
  )
})

afterEach(() => {
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled()
  }
  state.client = null
})

describe('createMeetingUpload', () => {
  it('sends exactly the five p_ arguments for a file and parses the row', async () => {
    const rpc = createRpcMock({
      data: [
        {
          upload_id: UPLOAD_ID,
          kind: 'audio',
          status: 'pending_upload',
          storage_path: PATH,
          mime_type: 'audio/mpeg',
        },
      ],
      error: null,
    })
    await expect(
      createMeetingUpload(CYCLE_ID, {
        kind: 'audio',
        filename: 'standup.MP3',
        size: 16,
      }),
    ).resolves.toEqual({
      uploadId: UPLOAD_ID,
      kind: 'audio',
      status: 'pending_upload',
      storagePath: PATH,
      mimeType: 'audio/mpeg',
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('create_meeting_upload', {
      p_cycle_id: CYCLE_ID,
      p_kind: 'audio',
      p_filename: 'standup.MP3',
      p_size_bytes: 16,
      p_pasted_text: null,
    })
  })

  it('sends text with null file fields', async () => {
    const rpc = createRpcMock({
      data: [
        {
          upload_id: TEXT_ID,
          kind: 'transcript_text',
          status: 'uploaded',
          storage_path: null,
          mime_type: null,
        },
      ],
      error: null,
    })
    await createMeetingUpload(CYCLE_ID, {
      kind: 'transcript_text',
      pasted_text: 'Hello team',
    })
    expect(rpc).toHaveBeenCalledWith('create_meeting_upload', {
      p_cycle_id: CYCLE_ID,
      p_kind: 'transcript_text',
      p_filename: null,
      p_size_bytes: null,
      p_pasted_text: 'Hello team',
    })
  })

  it.each<[string, Record<string, unknown>]>([
    [
      'a missing key',
      {
        upload_id: UPLOAD_ID,
        kind: 'audio',
        status: 'pending_upload',
        storage_path: PATH,
      },
    ],
    [
      'an extra key',
      {
        upload_id: UPLOAD_ID,
        kind: 'audio',
        status: 'pending_upload',
        storage_path: PATH,
        mime_type: 'audio/mpeg',
        token: TOKEN,
      },
    ],
    [
      'an unknown kind',
      {
        upload_id: UPLOAD_ID,
        kind: 'slides',
        status: 'pending_upload',
        storage_path: PATH,
        mime_type: 'audio/mpeg',
      },
    ],
    [
      'an unknown status',
      {
        upload_id: UPLOAD_ID,
        kind: 'audio',
        status: 'lost',
        storage_path: PATH,
        mime_type: 'audio/mpeg',
      },
    ],
    [
      'a file without a path',
      {
        upload_id: UPLOAD_ID,
        kind: 'audio',
        status: 'pending_upload',
        storage_path: null,
        mime_type: 'audio/mpeg',
      },
    ],
    [
      "a file with another kind's type",
      {
        upload_id: UPLOAD_ID,
        kind: 'audio',
        status: 'pending_upload',
        storage_path: PATH,
        mime_type: 'video/mp4',
      },
    ],
    [
      'text with a path',
      {
        upload_id: UPLOAD_ID,
        kind: 'transcript_text',
        status: 'uploaded',
        storage_path: PATH,
        mime_type: null,
      },
    ],
  ])('refuses %s as unknown', async (_label, row) => {
    createRpcMock({ data: [row], error: null })
    const kind = row.kind === 'transcript_text' ? 'transcript_text' : 'audio'
    const request =
      kind === 'transcript_text'
        ? ({ kind, pasted_text: 'x' } as const)
        : ({ kind, filename: 'a.mp3', size: 16 } as const)
    expect(await codeOf(createMeetingUpload(CYCLE_ID, request))).toBe('unknown')
  })

  it('maps a known code and refuses an unknown one, keeping no server text', async () => {
    createRpcMock({ data: null, error: { message: 'upload_limit_reached' } })
    const error = await createMeetingUpload(CYCLE_ID, {
      kind: 'audio',
      filename: 'a.mp3',
      size: 1,
    }).catch((reason: unknown) => reason)
    expect(uploadErrorCodeOf(error)).toBe('upload_limit_reached')
    createRpcMock({ data: null, error: { message: 'boom: a.mp3 details' } })
    expect(
      await codeOf(
        createMeetingUpload(CYCLE_ID, {
          kind: 'audio',
          filename: 'a.mp3',
          size: 1,
        }),
      ),
    ).toBe('unknown')
  })
})

describe('completeMeetingUpload', () => {
  it('sends only p_upload_id and parses the row', async () => {
    const rpc = createRpcMock({
      data: [
        {
          upload_id: UPLOAD_ID,
          status: 'rejected',
          error_code: 'upload_file_mismatch',
        },
      ],
      error: null,
    })
    await expect(completeMeetingUpload(UPLOAD_ID)).resolves.toEqual({
      uploadId: UPLOAD_ID,
      status: 'rejected',
      errorCode: 'upload_file_mismatch',
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('complete_meeting_upload', {
      p_upload_id: UPLOAD_ID,
    })
  })

  it.each<[string, unknown]>([
    [
      'an extra key',
      [
        {
          upload_id: UPLOAD_ID,
          status: 'uploaded',
          error_code: null,
          path: PATH,
        },
      ],
    ],
    [
      'an unknown status',
      [{ upload_id: UPLOAD_ID, status: 'done', error_code: null }],
    ],
    [
      'another id',
      [{ upload_id: TEXT_ID, status: 'uploaded', error_code: null }],
    ],
    ['no row', []],
  ])('refuses %s as unknown', async (_label, data) => {
    createRpcMock({ data, error: null })
    expect(await codeOf(completeMeetingUpload(UPLOAD_ID))).toBe('unknown')
  })

  it('maps upload_file_missing', async () => {
    createRpcMock({ data: null, error: { message: 'upload_file_missing' } })
    expect(await codeOf(completeMeetingUpload(UPLOAD_ID))).toBe(
      'upload_file_missing',
    )
  })
})

describe('fetchCycleUploads', () => {
  it('sends only p_cycle_id and maps every field in server order', async () => {
    const rpc = createRpcMock({
      data: { cycle_id: CYCLE_ID, uploads: [textItem(), fileItem()] },
      error: null,
    })
    const result = await fetchCycleUploads(CYCLE_ID)
    expect(rpc).toHaveBeenCalledWith('get_cycle_uploads', {
      p_cycle_id: CYCLE_ID,
    })
    expect(result.uploads.map((upload) => upload.uploadId)).toEqual([
      TEXT_ID,
      UPLOAD_ID,
    ])
    expect(result.uploads[1]).toEqual({
      uploadId: UPLOAD_ID,
      kind: 'audio',
      status: 'uploaded',
      originalFilename: 'standup.MP3',
      mimeType: 'audio/mpeg',
      sizeBytes: 16,
      textLength: null,
      storagePath: PATH,
      errorCode: null,
      errorMessage: null,
      createdAt: T,
      uploadedAt: T,
      updatedAt: T,
    })
    expect(result.uploads[0].textLength).toBe(12)
  })

  it.each<[string, unknown]>([
    [
      'a missing key',
      {
        cycle_id: CYCLE_ID,
        uploads: [withoutKey(fileItem(), 'text_length')],
      },
    ],
    [
      'an extra key',
      { cycle_id: CYCLE_ID, uploads: [fileItem({ pasted_text: 'secret' })] },
    ],
    ['an extra top-level key', { cycle_id: CYCLE_ID, uploads: [], other: 1 }],
    [
      'an unknown kind',
      { cycle_id: CYCLE_ID, uploads: [fileItem({ kind: 'slides' })] },
    ],
    [
      'an unknown status',
      { cycle_id: CYCLE_ID, uploads: [fileItem({ status: 'lost' })] },
    ],
    [
      'an error code that is not a code',
      {
        cycle_id: CYCLE_ID,
        uploads: [
          fileItem({
            status: 'rejected',
            uploaded_at: null,
            error_code: 'Bad code',
          }),
        ],
      },
    ],
    [
      'a file with text_length',
      { cycle_id: CYCLE_ID, uploads: [fileItem({ text_length: 3 })] },
    ],
    [
      'text with a file name',
      {
        cycle_id: CYCLE_ID,
        uploads: [textItem({ original_filename: 'a.txt' })],
      },
    ],
    [
      'text without text_length',
      { cycle_id: CYCLE_ID, uploads: [textItem({ text_length: null })] },
    ],
    [
      'uploaded without uploaded_at',
      { cycle_id: CYCLE_ID, uploads: [fileItem({ uploaded_at: null })] },
    ],
    ['another cycle', { cycle_id: TEXT_ID, uploads: [] }],
  ])('refuses %s as unknown', async (_label, data) => {
    createRpcMock({ data, error: null })
    expect(await codeOf(fetchCycleUploads(CYCLE_ID))).toBe('unknown')
  })
})

describe('uploadMeetingFile', () => {
  const file = new File([new Uint8Array(16)], 'standup.MP3', { type: '' })

  it('signs the path only, then uploads a Blob of the given type with that path and token and no upsert', async () => {
    const storage = createStorageMock({
      data: { signedUrl: `https://x/${TOKEN}`, token: TOKEN, path: PATH },
      error: null,
    })
    const result = await uploadMeetingFile({
      storagePath: PATH,
      mimeType: 'audio/mpeg',
      file,
    })
    expect(result).toBeUndefined()
    expect(JSON.stringify(result ?? null)).not.toContain(TOKEN)
    expect(storage.from).toHaveBeenCalledWith('meeting-media')
    expect(storage.createSignedUploadUrl).toHaveBeenCalledTimes(1)
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(PATH)
    expect(storage.uploadToSignedUrl).toHaveBeenCalledTimes(1)
    const [path, token, body, options] = storage.uploadToSignedUrl.mock
      .calls[0] as unknown as [string, string, Blob, Record<string, unknown>]
    expect(path).toBe(PATH)
    expect(token).toBe(TOKEN)
    expect(body).toBeInstanceOf(Blob)
    expect(body.type).toBe('audio/mpeg')
    expect(body.size).toBe(16)
    expect(options).toEqual({ contentType: 'audio/mpeg' })
    expect(options).not.toHaveProperty('upsert')
  })

  it('resolves on "already exists" (409) from the signing or the upload', async () => {
    createStorageMock({
      data: null,
      error: {
        message: 'The resource already exists',
        status: 400,
        statusCode: '409',
      },
    })
    await expect(
      uploadMeetingFile({ storagePath: PATH, mimeType: 'audio/mpeg', file }),
    ).resolves.toBeUndefined()
    createStorageMock(
      { data: { token: TOKEN, signedUrl: 'x', path: PATH }, error: null },
      { data: null, error: { message: 'Duplicate', status: 409 } },
    )
    await expect(
      uploadMeetingFile({ storagePath: PATH, mimeType: 'audio/mpeg', file }),
    ).resolves.toBeUndefined()
  })

  it('maps 413 to upload_too_large and anything else to upload_failed', async () => {
    createStorageMock(
      { data: { token: TOKEN, signedUrl: 'x', path: PATH }, error: null },
      {
        data: null,
        error: { message: 'Payload too large', status: 400, statusCode: '413' },
      },
    )
    expect(
      await codeOf(
        uploadMeetingFile({ storagePath: PATH, mimeType: 'audio/mpeg', file }),
      ),
    ).toBe('upload_too_large')
    createStorageMock(
      { data: { token: TOKEN, signedUrl: 'x', path: PATH }, error: null },
      { data: null, error: { message: 'Payload too large', status: 413 } },
    )
    expect(
      await codeOf(
        uploadMeetingFile({ storagePath: PATH, mimeType: 'audio/mpeg', file }),
      ),
    ).toBe('upload_too_large')
    createStorageMock({
      data: null,
      error: {
        message: 'new row violates row-level security policy',
        status: 400,
        statusCode: '403',
      },
    })
    expect(
      await codeOf(
        uploadMeetingFile({ storagePath: PATH, mimeType: 'audio/mpeg', file }),
      ),
    ).toBe('upload_failed')
    const storage = createStorageMock({
      data: { token: TOKEN, signedUrl: 'x', path: PATH },
      error: null,
    })
    storage.uploadToSignedUrl.mockRejectedValueOnce(new TypeError('offline'))
    const error = await uploadMeetingFile({
      storagePath: PATH,
      mimeType: 'audio/mpeg',
      file,
    }).catch((reason: unknown) => reason)
    expect(uploadErrorCodeOf(error)).toBe('upload_failed')
    expect(String(error)).not.toContain(TOKEN)
  })
})
