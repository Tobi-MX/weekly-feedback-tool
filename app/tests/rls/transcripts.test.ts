import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  decodeTranscriptBytes,
  isTranscriptParseError,
  parseTranscript,
  type ParsedTranscript,
  type TranscriptSegment,
} from '../../src/uploads/transcriptParser'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createRoleCast,
  makeFacilitator,
  projectWithRoles,
  removeMeetingObjects,
  unknownId,
  type ProjectWithRoles,
  type RoleCast,
  type TestUser,
} from './fixtures'

interface CreatedCycleRow {
  readonly id: string
}

interface StageRow {
  readonly status: string
}

interface CreatedUploadRow {
  readonly upload_id: string
  readonly status: string
  readonly storage_path: string | null
  readonly mime_type: string | null
}

interface StoredRow {
  readonly upload_id: string
  readonly status: string
  readonly text_length: number
  readonly segment_count: number
}

interface RejectedRow {
  readonly upload_id: string
  readonly status: string
  readonly error_code: string | null
}

interface PastedRow {
  readonly upload_id: string
  readonly pasted_text: string
}

interface UploadItem {
  readonly upload_id: string
  readonly status: string
  readonly transcript_length: number | null
  readonly transcript_segment_count: number | null
}

interface CycleUploads {
  readonly cycle_id: string
  readonly uploads: readonly UploadItem[]
}

const BUCKET = 'meeting-media'
const VTT = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:02.000',
  '<v Alice>We shipped it',
  '',
  '00:00:02.000 --> 00:00:04.500',
  'Bob: Great',
  '',
].join('\n')

/** The Monday of the current UTC week, as the database's current_date sees it. */
function thisMonday(): string {
  const now = new Date()
  const offset = (now.getUTCDay() + 6) % 7
  const monday = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - offset,
    ),
  )
  return monday.toISOString().slice(0, 10)
}

/** Every project this file creates, for the object teardown. */
const projectIds: string[] = []

async function rpc<T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<DbResult<T>> {
  return (await client.rpc(fn, args)) as DbResult<T>
}

async function discussCycle(owner: TestUser, projectId: string) {
  const [cycle] = expectRows(
    await rpc<CreatedCycleRow[]>(owner.client, 'create_cycle', {
      p_project_id: projectId,
      p_title: 'Transcripts week',
      p_week_start: thisMonday(),
    }),
    1,
  )
  const steps: Array<[string, Record<string, unknown>]> = [
    ['start_retrospective', { p_cycle_id: cycle.id }],
    ['advance_stage', { p_cycle_id: cycle.id, p_from_status: 'reveal' }],
    ['create_cluster', { p_cycle_id: cycle.id, p_name: 'Topic' }],
    ['advance_stage', { p_cycle_id: cycle.id, p_from_status: 'cluster' }],
    ['close_voting', { p_cycle_id: cycle.id }],
  ]
  for (const [fn, args] of steps) {
    expectRows(await rpc<StageRow[]>(owner.client, fn, args), 1)
  }
  return cycle.id
}

async function closeCycle(user: TestUser, cycleId: string): Promise<void> {
  const closed = await user.client.rpc('close_cycle', { p_cycle_id: cycleId })
  expect(closed.error).toBeNull()
}

/** Registers, uploads through a signed upload URL, and completes a file. */
async function uploadedTranscript(
  user: TestUser,
  cycleId: string,
  filename: string,
  content: string,
): Promise<{ readonly uploadId: string; readonly path: string }> {
  const body = new TextEncoder().encode(content)
  const [row] = expectRows(
    await rpc<CreatedUploadRow[]>(user.client, 'create_meeting_upload', {
      p_cycle_id: cycleId,
      p_kind: 'transcript_file',
      p_filename: filename,
      p_size_bytes: body.byteLength,
      p_pasted_text: null,
    }),
    1,
  )
  if (row.storage_path === null || row.mime_type === null) {
    throw new Error('a file upload must return a path and a MIME type')
  }
  const bucket = user.client.storage.from(BUCKET)
  const signed = await bucket.createSignedUploadUrl(row.storage_path)
  expect(signed.error).toBeNull()
  const uploaded = await bucket.uploadToSignedUrl(
    row.storage_path,
    signed.data?.token ?? '',
    new Blob([body], { type: row.mime_type }),
    { contentType: row.mime_type },
  )
  expect(uploaded.error).toBeNull()
  const [completed] = expectRows(
    await rpc<RejectedRow[]>(user.client, 'complete_meeting_upload', {
      p_upload_id: row.upload_id,
    }),
    1,
  )
  expect(completed.status).toBe('uploaded')
  return { uploadId: row.upload_id, path: row.storage_path }
}

async function pastedUpload(
  user: TestUser,
  cycleId: string,
  text: string,
): Promise<string> {
  const [row] = expectRows(
    await rpc<CreatedUploadRow[]>(user.client, 'create_meeting_upload', {
      p_cycle_id: cycleId,
      p_kind: 'transcript_text',
      p_filename: null,
      p_size_bytes: null,
      p_pasted_text: text,
    }),
    1,
  )
  expect(row.status).toBe('uploaded')
  return row.upload_id
}

/** The browser's read: a 60-second signed URL, then fetch. Null if refused. */
async function signedDownload(
  client: SupabaseClient,
  path: string,
): Promise<Uint8Array | null> {
  const signed = await client.storage.from(BUCKET).createSignedUrl(path, 60)
  if (signed.error) {
    expect(signed.data).toBeNull()
    return null
  }
  const response = await fetch(signed.data.signedUrl)
  expect(response.ok).toBe(true)
  return new Uint8Array(await response.arrayBuffer())
}

function parsedFrom(bytes: Uint8Array, format: 'vtt' | 'auto') {
  const text = decodeTranscriptBytes(bytes)
  if (typeof text !== 'string') {
    throw new Error(`decode failed: ${text.code}`)
  }
  const result = parseTranscript(text, format)
  if (isTranscriptParseError(result)) {
    throw new Error(`parse failed: ${result.code}`)
  }
  return result
}

function store(
  client: SupabaseClient,
  uploadId: string,
  text: string,
  segments: readonly TranscriptSegment[],
) {
  return rpc<StoredRow[]>(client, 'store_transcript', {
    p_upload_id: uploadId,
    p_text: text,
    p_segments: segments,
  })
}

function reject(client: SupabaseClient, uploadId: string, reason: string) {
  return rpc<RejectedRow[]>(client, 'reject_transcript_upload', {
    p_upload_id: uploadId,
    p_reason: reason,
  })
}

function pastedText(client: SupabaseClient, uploadId: string) {
  return rpc<PastedRow[]>(client, 'get_pasted_transcript_text', {
    p_upload_id: uploadId,
  })
}

async function listItem(
  user: TestUser,
  cycleId: string,
  uploadId: string,
): Promise<UploadItem | undefined> {
  const listed = await rpc<CycleUploads>(user.client, 'get_cycle_uploads', {
    p_cycle_id: cycleId,
  })
  expect(listed.error).toBeNull()
  return listed.data?.uploads.find((u) => u.upload_id === uploadId)
}

describe('transcripts', () => {
  let roleCast: RoleCast

  beforeAll(async () => {
    roleCast = await createRoleCast('transcripts')
  })

  afterAll(async () => {
    await removeMeetingObjects(projectIds)
  })

  async function setup(): Promise<ProjectWithRoles & { cycleId: string }> {
    const roles = await projectWithRoles(roleCast)
    projectIds.push(roles.project.id)
    const cycleId = await discussCycle(roles.owner, roles.project.id)
    return { ...roles, cycleId }
  }

  it('facilitator downloads exactly the uploaded VTT through a signed URL, stores its parse, and lists it', async () => {
    const { owner, cycleId } = await setup()
    const { uploadId, path } = await uploadedTranscript(
      owner,
      cycleId,
      'standup.vtt',
      VTT,
    )
    const bytes = await signedDownload(owner.client, path)
    expect(bytes).not.toBeNull()
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe(VTT)
    const parsed = parsedFrom(bytes ?? new Uint8Array(), 'vtt')
    expect(parsed.text).toBe('Alice: We shipped it\nBob: Great')
    expect(
      expectRows(
        await store(owner.client, uploadId, parsed.text, parsed.segments),
        1,
      ),
    ).toEqual([
      {
        upload_id: uploadId,
        status: 'extracting',
        text_length: 31,
        segment_count: 2,
      },
    ])
    expect(await listItem(owner, cycleId, uploadId)).toMatchObject({
      status: 'extracting',
      transcript_length: 31,
      transcript_segment_count: 2,
    })
  })

  it('facilitator reads registered pasted text back and stores it with no segments', async () => {
    const { owner, cycleId } = await setup()
    const text = '﻿Alice: Hi\r\n\r\n\r\nBob: Hello'
    const uploadId = await pastedUpload(owner, cycleId, text)
    expect(expectRows(await pastedText(owner.client, uploadId), 1)).toEqual([
      { upload_id: uploadId, pasted_text: text },
    ])
    const parsed = parsedFrom(new TextEncoder().encode(text), 'auto')
    expect(parsed).toEqual({
      format: 'plain',
      text: 'Alice: Hi\n\nBob: Hello',
      segments: [],
    })
    const [row] = expectRows(
      await store(owner.client, uploadId, parsed.text, []),
      1,
    )
    expect(row).toMatchObject({ status: 'extracting', segment_count: 0 })
  })

  it('facilitator stores a 200,000-character transcript with 20,000 segments in one call', async () => {
    const { owner, cycleId } = await setup()
    const uploadId = await pastedUpload(owner, cycleId, 'placeholder')
    const segments: TranscriptSegment[] = Array.from(
      { length: 20_000 },
      (_, i) => ({
        start_ms: i * 1000,
        end_ms: i * 1000 + 900,
        text: i === 0 ? 'abcdefghij' : 'abcdefghi',
      }),
    )
    const parsed: ParsedTranscript = {
      format: 'vtt',
      text: segments.map((s) => s.text).join('\n'),
      segments,
    }
    expect([...parsed.text]).toHaveLength(200_000)
    const requestBytes = new TextEncoder().encode(
      JSON.stringify({
        p_upload_id: uploadId,
        p_text: parsed.text,
        p_segments: segments,
      }),
    ).byteLength
    // About 1.3 MB; the PR states the measured size.
    expect(requestBytes).toBeLessThan(2_000_000)
    const [row] = expectRows(
      await store(owner.client, uploadId, parsed.text, segments),
      1,
    )
    expect(row).toMatchObject({
      status: 'extracting',
      text_length: 200_000,
      segment_count: 20_000,
    })
  })

  it('member, owner-not-facilitator, non-member and signed-out clients get no download and no RPC', async () => {
    const { project, owner, memberA, memberB, nonMember, cycleId } =
      await setup()
    const file = await uploadedTranscript(owner, cycleId, 'a.vtt', VTT)
    const text = await pastedUpload(owner, cycleId, 'Pasted words')
    const anon = anonClient()

    // Member B, non-member C and anon, while the owner is the facilitator.
    for (const client of [memberA.client, nonMember.client, anon]) {
      expect(await signedDownload(client, file.path)).toBeNull()
    }
    expectPgError(
      await store(memberA.client, file.uploadId, 'a', []),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await reject(memberA.client, file.uploadId, 'transcript_empty'),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await pastedText(memberA.client, text),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await store(nonMember.client, file.uploadId, 'a', []),
      'P0001',
      'upload_not_found',
    )
    expectPgError(
      await reject(nonMember.client, file.uploadId, 'transcript_empty'),
      'P0001',
      'upload_not_found',
    )
    expectPgError(
      await pastedText(nonMember.client, text),
      'P0001',
      'upload_not_found',
    )
    expectPgError(
      await store(owner.client, unknownId(), 'a', []),
      'P0001',
      'upload_not_found',
    )
    // A signed-out client cannot even call the RPCs.
    for (const result of [
      await store(anon, file.uploadId, 'a', []),
      await reject(anon, file.uploadId, 'transcript_empty'),
      await pastedText(anon, text),
    ]) {
      expect(result.data).toBeNull()
      expect(result.error).not.toBeNull()
    }

    // The owner who is no longer the facilitator.
    await makeFacilitator(project, owner, memberB)
    expect(await signedDownload(owner.client, file.path)).toBeNull()
    expectPgError(
      await store(owner.client, file.uploadId, 'a', []),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await reject(owner.client, file.uploadId, 'transcript_empty'),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await pastedText(owner.client, text),
      '42501',
      'not_project_facilitator',
    )
  })

  it('every client role, the facilitator included, gets a permission error on the transcripts table', async () => {
    const { owner, memberA, nonMember, cycleId } = await setup()
    const uploadId = await pastedUpload(owner, cycleId, 'Hello')
    expectRows(await store(owner.client, uploadId, 'Hello', []), 1)
    for (const client of [
      owner.client,
      memberA.client,
      nonMember.client,
      anonClient(),
    ]) {
      expectPgError(await client.from('transcripts').select(), '42501')
      expectPgError(
        await client
          .from('transcripts')
          .insert({ upload_id: uploadId, text: 'x' }),
        '42501',
      )
      expectPgError(
        await client
          .from('transcripts')
          .update({ text: 'x' })
          .eq('upload_id', uploadId),
        '42501',
      )
      expectPgError(
        await client.from('transcripts').delete().eq('upload_id', uploadId),
        '42501',
      )
    }
  })

  it('after a transfer, the new facilitator downloads, stores and rejects earlier uploads, and the old one cannot', async () => {
    const { project, owner, memberB, cycleId } = await setup()
    const first = await uploadedTranscript(owner, cycleId, 'one.vtt', VTT)
    const second = await uploadedTranscript(
      owner,
      cycleId,
      'two.txt',
      'Latin-1 café',
    )
    await makeFacilitator(project, owner, memberB)

    expect(await signedDownload(owner.client, first.path)).toBeNull()
    expectPgError(
      await store(owner.client, first.uploadId, 'a', []),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await reject(owner.client, second.uploadId, 'transcript_empty'),
      '42501',
      'not_project_facilitator',
    )

    const bytes = await signedDownload(memberB.client, first.path)
    expect(bytes).not.toBeNull()
    const parsed = parsedFrom(bytes ?? new Uint8Array(), 'vtt')
    expect(
      expectRows(
        await store(
          memberB.client,
          first.uploadId,
          parsed.text,
          parsed.segments,
        ),
        1,
      )[0].status,
    ).toBe('extracting')
    expect(await signedDownload(memberB.client, second.path)).not.toBeNull()
    expect(
      expectRows(
        await reject(
          memberB.client,
          second.uploadId,
          'transcript_bad_encoding',
        ),
        1,
      ),
    ).toEqual([
      {
        upload_id: second.uploadId,
        status: 'rejected',
        error_code: 'transcript_bad_encoding',
      },
    ])
  })

  it('works in closed', async () => {
    const { owner, cycleId } = await setup()
    const file = await uploadedTranscript(owner, cycleId, 'late.vtt', VTT)
    await closeCycle(owner, cycleId)
    const bytes = await signedDownload(owner.client, file.path)
    const parsed = parsedFrom(bytes ?? new Uint8Array(), 'vtt')
    expectRows(
      await store(owner.client, file.uploadId, parsed.text, parsed.segments),
      1,
    )
  })
})
