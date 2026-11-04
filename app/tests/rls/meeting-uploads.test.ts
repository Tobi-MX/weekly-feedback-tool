import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createProject,
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

interface ClusterRow {
  readonly cluster_id: string
}

interface CreatedUploadRow {
  readonly upload_id: string
  readonly kind: string
  readonly status: string
  readonly storage_path: string | null
  readonly mime_type: string | null
}

interface CompletedUploadRow {
  readonly upload_id: string
  readonly status: string
  readonly error_code: string | null
}

interface UploadItem {
  readonly upload_id: string
  readonly kind: string
  readonly status: string
  readonly original_filename: string | null
  readonly storage_path: string | null
  readonly size_bytes: number | null
  readonly text_length: number | null
}

interface CycleUploads {
  readonly cycle_id: string
  readonly uploads: readonly UploadItem[]
}

const BUCKET = 'meeting-media'

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

function bytes(n: number, fill = 7): Uint8Array {
  return new Uint8Array(n).fill(fill)
}

/** Every project this file creates, for the object teardown. */
const projectIds: string[] = []

async function discussCycle(
  owner: TestUser,
  projectId: string,
): Promise<string> {
  const made: DbResult<CreatedCycleRow[]> = await owner.client.rpc(
    'create_cycle',
    {
      p_project_id: projectId,
      p_title: 'Uploads week',
      p_week_start: thisMonday(),
    },
  )
  const [cycle] = expectRows(made, 1)
  const started: DbResult<StageRow[]> = await owner.client.rpc(
    'start_retrospective',
    { p_cycle_id: cycle.id },
  )
  expect(expectRows(started, 1)[0].status).toBe('reveal')
  const toCluster: DbResult<StageRow[]> = await owner.client.rpc(
    'advance_stage',
    { p_cycle_id: cycle.id, p_from_status: 'reveal' },
  )
  expect(expectRows(toCluster, 1)[0].status).toBe('cluster')
  const cluster: DbResult<ClusterRow[]> = await owner.client.rpc(
    'create_cluster',
    { p_cycle_id: cycle.id, p_name: 'Topic' },
  )
  expectRows(cluster, 1)
  const toVote: DbResult<StageRow[]> = await owner.client.rpc('advance_stage', {
    p_cycle_id: cycle.id,
    p_from_status: 'cluster',
  })
  expect(expectRows(toVote, 1)[0].status).toBe('vote')
  const closed: DbResult<StageRow[]> = await owner.client.rpc('close_voting', {
    p_cycle_id: cycle.id,
  })
  expect(expectRows(closed, 1)[0].status).toBe('discuss')
  return cycle.id
}

async function closeCycle(owner: TestUser, cycleId: string): Promise<void> {
  const closed = await owner.client.rpc('close_cycle', { p_cycle_id: cycleId })
  expect(closed.error).toBeNull()
}

function createUpload(
  client: SupabaseClient,
  cycleId: string,
  fields: {
    readonly kind: string
    readonly filename?: string | null
    readonly size?: number | null
    readonly text?: string | null
  },
): PromiseLike<DbResult<CreatedUploadRow[]>> {
  return client.rpc('create_meeting_upload', {
    p_cycle_id: cycleId,
    p_kind: fields.kind,
    p_filename: fields.filename ?? null,
    p_size_bytes: fields.size ?? null,
    p_pasted_text: fields.text ?? null,
  })
}

function completeUpload(
  client: SupabaseClient,
  uploadId: string,
): PromiseLike<DbResult<CompletedUploadRow[]>> {
  return client.rpc('complete_meeting_upload', { p_upload_id: uploadId })
}

function listUploads(
  client: SupabaseClient,
  cycleId: string,
): PromiseLike<DbResult<CycleUploads>> {
  return client.rpc('get_cycle_uploads', { p_cycle_id: cycleId })
}

async function registered(
  user: TestUser,
  cycleId: string,
  filename: string,
  size: number,
  kind = 'audio',
): Promise<CreatedUploadRow & { storage_path: string; mime_type: string }> {
  const [row] = expectRows(
    await createUpload(user.client, cycleId, { kind, filename, size }),
    1,
  )
  expect(row.status).toBe('pending_upload')
  if (row.storage_path === null || row.mime_type === null) {
    throw new Error('a file upload must return a path and a MIME type')
  }
  return { ...row, storage_path: row.storage_path, mime_type: row.mime_type }
}

/** The browser path: a signed upload URL, then the upload. Error or null. */
async function signedUpload(
  client: SupabaseClient,
  path: string,
  body: Blob,
  options: { readonly upsert?: boolean } = {},
): Promise<{ readonly status: number | undefined } | null> {
  const bucket = client.storage.from(BUCKET)
  const signed =
    options.upsert === true
      ? await bucket.createSignedUploadUrl(path, { upsert: true })
      : await bucket.createSignedUploadUrl(path)
  if (signed.error) {
    return { status: statusOf(signed.error) }
  }
  const uploaded = await bucket.uploadToSignedUrl(
    path,
    signed.data.token,
    body,
    {
      contentType: body.type,
    },
  )
  return uploaded.error ? { status: statusOf(uploaded.error) } : null
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status
    return typeof status === 'number' ? status : undefined
  }
  return undefined
}

async function download(
  client: SupabaseClient,
  path: string,
): Promise<Uint8Array | null> {
  const result = await client.storage.from(BUCKET).download(path)
  if (result.error) {
    return null
  }
  return new Uint8Array(await result.data.arrayBuffer())
}

async function uploadedFile(
  user: TestUser,
  cycleId: string,
  size = 16,
): Promise<string> {
  const row = await registered(user, cycleId, 'standup.mp3', size)
  expect(
    await signedUpload(
      user.client,
      row.storage_path,
      new Blob([bytes(size)], { type: row.mime_type }),
    ),
  ).toBeNull()
  expect(
    expectRows(await completeUpload(user.client, row.upload_id), 1),
  ).toEqual([
    { upload_id: row.upload_id, status: 'uploaded', error_code: null },
  ])
  return row.storage_path
}

describe('meeting uploads', () => {
  let roleCast: RoleCast

  beforeAll(async () => {
    roleCast = await createRoleCast('uploads')
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

  it('facilitator A registers, uploads, completes, reads back, and lists an audio file; pasted text needs no Storage call', async () => {
    const { owner: a, cycleId, project } = await setup()

    const row = await registered(a, cycleId, 'Standup.MP3', 16)
    expect(row.mime_type).toBe('audio/mpeg')
    expect(row.storage_path).toBe(
      `${project.id}/${cycleId}/${row.upload_id}.mp3`,
    )

    const bucket = a.client.storage.from(BUCKET)
    const signed = await bucket.createSignedUploadUrl(row.storage_path)
    expect(signed.error).toBeNull()
    const token = signed.data?.token ?? ''
    const uploaded = await bucket.uploadToSignedUrl(
      row.storage_path,
      token,
      new Blob([bytes(16, 3)], { type: 'audio/mpeg' }),
      { contentType: 'audio/mpeg' },
    )
    expect(uploaded.error).toBeNull()

    expect(
      expectRows(await completeUpload(a.client, row.upload_id), 1),
    ).toEqual([
      { upload_id: row.upload_id, status: 'uploaded', error_code: null },
    ])

    const url = await bucket.createSignedUrl(row.storage_path, 60)
    expect(url.error).toBeNull()
    const response = await fetch(url.data?.signedUrl ?? '')
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes(16, 3))

    const text = expectRows(
      await createUpload(a.client, cycleId, {
        kind: 'transcript_text',
        text: 'We talked about the release.',
      }),
      1,
    )
    expect(text[0]).toMatchObject({
      kind: 'transcript_text',
      status: 'uploaded',
      storage_path: null,
      mime_type: null,
    })

    const listed = await listUploads(a.client, cycleId)
    expect(listed.error).toBeNull()
    expect(listed.data?.cycle_id).toBe(cycleId)
    expect(listed.data?.uploads.map((item) => item.upload_id)).toEqual([
      text[0].upload_id,
      row.upload_id,
    ])
    expect(listed.data?.uploads[1]).toMatchObject({
      status: 'uploaded',
      original_filename: 'Standup.MP3',
      size_bytes: 16,
      text_length: null,
    })
    expect(listed.data?.uploads[0].text_length).toBe(28)
    expect(JSON.stringify(listed.data)).not.toContain('release')
  })

  it('member B, the owner-not-facilitator, non-member C and a signed-out client get no write, read, list or RPC', async () => {
    const roles = await setup()
    const { owner: a, memberA: b, memberB: d, nonMember: c, cycleId } = roles
    const uploadedPath = await uploadedFile(a, cycleId)
    const pending = await registered(a, cycleId, 'later.mp3', 16)
    const uploadedId = (
      await listUploads(a.client, cycleId)
    ).data?.uploads.find(
      (item) => item.storage_path === uploadedPath,
    )?.upload_id
    expect(uploadedId).toBeDefined()

    const prefix = `${roles.project.id}/${cycleId}`
    const outsiders: Array<{
      readonly name: string
      readonly client: SupabaseClient
      readonly createCode: [string, string?]
      readonly completeCode: [string, string?]
      readonly listCode: [string, string?]
    }> = [
      {
        name: 'member B',
        client: b.client,
        createCode: ['42501', 'not_project_facilitator'],
        completeCode: ['42501', 'not_project_facilitator'],
        listCode: ['42501', 'not_project_facilitator'],
      },
      {
        name: 'non-member C',
        client: c.client,
        createCode: ['42501', 'not_project_member'],
        completeCode: ['P0001', 'upload_not_found'],
        listCode: ['42501', 'not_project_member'],
      },
      // anon holds no EXECUTE on the RPCs: Postgres refuses with 42501
      // before the function runs.
      {
        name: 'signed out',
        client: anonClient(),
        createCode: ['42501'],
        completeCode: ['42501'],
        listCode: ['42501'],
      },
    ]

    const check = async (outsider: (typeof outsiders)[number]) => {
      const bucket = outsider.client.storage.from(BUCKET)
      const signed = await bucket.createSignedUploadUrl(pending.storage_path)
      expect(signed.error, `${outsider.name} signed upload`).not.toBeNull()
      const direct = await bucket.upload(
        pending.storage_path,
        new Blob([bytes(16)], { type: 'audio/mpeg' }),
        { contentType: 'audio/mpeg' },
      )
      expect(direct.error, `${outsider.name} direct upload`).not.toBeNull()
      const url = await bucket.createSignedUrl(uploadedPath, 60)
      expect(url.error, `${outsider.name} signed read`).not.toBeNull()
      expect(await download(outsider.client, uploadedPath)).toBeNull()
      const listing = await bucket.list(prefix)
      expect(listing.data ?? []).toEqual([])

      expectPgError(
        await createUpload(outsider.client, cycleId, {
          kind: 'audio',
          filename: 'x.mp3',
          size: 16,
        }),
        ...outsider.createCode,
      )
      expectPgError(
        await completeUpload(outsider.client, pending.upload_id),
        ...outsider.completeCode,
      )
      expectPgError(
        await listUploads(outsider.client, cycleId),
        ...outsider.listCode,
      )
    }

    for (const outsider of outsiders) {
      await check(outsider)
    }

    // The owner who is no longer the facilitator.
    await makeFacilitator(roles.project, a, d)
    await check({
      name: 'owner not facilitator',
      client: a.client,
      createCode: ['42501', 'not_project_facilitator'],
      completeCode: ['42501', 'not_project_facilitator'],
      listCode: ['42501', 'not_project_facilitator'],
    })

    // Nothing reached the bucket or the rows.
    const seen = await listUploads(d.client, cycleId)
    expect(seen.data?.uploads.map((item) => item.status).sort()).toEqual([
      'pending_upload',
      'uploaded',
    ])
    expect(await download(d.client, pending.storage_path)).toBeNull()
    expect(uploadedId).toBeTruthy()
  })

  it('A cannot sign or upload outside registered pending paths, cannot overwrite, and cannot remove, move or copy', async () => {
    const { owner: a, cycleId, project } = await setup()
    const uploadedPath = await uploadedFile(a, cycleId)
    const pending = await registered(a, cycleId, 'next.mp3', 16)

    const other = await createProject(a)
    projectIds.push(other.id)
    const otherCycle = await discussCycle(a, other.id)
    // Q: a project A is not a member of.
    const q = await createProject(roleCast.nonMember)
    projectIds.push(q.id)
    const qCycle = await discussCycle(roleCast.nonMember, q.id)
    const qRow = await registered(roleCast.nonMember, qCycle, 'q.mp3', 16)

    const refusedPaths = [
      `${project.id}/${cycleId}/${unknownId()}.mp3`,
      `${pending.storage_path}/../x.mp3`,
      `../${pending.storage_path}`,
      pending.storage_path.replace(/\.mp3$/, '.MP3'),
      qRow.storage_path,
      `${other.id}/${otherCycle}/${pending.upload_id}.mp3`,
      uploadedPath,
    ]
    const body = new Blob([bytes(16, 9)], { type: 'audio/mpeg' })
    for (const path of refusedPaths) {
      expect(await signedUpload(a.client, path, body), path).not.toBeNull()
      const direct = await a.client.storage
        .from(BUCKET)
        .upload(path, body, { contentType: 'audio/mpeg' })
      expect(direct.error, `direct ${path}`).not.toBeNull()
    }
    // A trailing slash never matches a policy. (supabase-js strips it from a
    // direct upload, which then names the registered path itself.)
    expect(
      await signedUpload(a.client, `${pending.storage_path}/`, body),
    ).not.toBeNull()
    expect(
      await signedUpload(a.client, uploadedPath, body, { upsert: true }),
    ).not.toBeNull()
    const upsert = await a.client.storage
      .from(BUCKET)
      .upload(uploadedPath, body, { contentType: 'audio/mpeg', upsert: true })
    expect(upsert.error).not.toBeNull()

    const bucket = a.client.storage.from(BUCKET)
    const removed = await bucket.remove([uploadedPath])
    expect(removed.data ?? []).toEqual([])
    const moved = await bucket.move(uploadedPath, pending.storage_path)
    expect(moved.error).not.toBeNull()
    // A copy needs an INSERT on its destination, so it is refused for any
    // path that is not a registered pending_upload path. (Copying into a
    // registered pending path is the same as uploading to it, and completion
    // still checks the object.)
    for (const destination of [
      uploadedPath,
      `${project.id}/${cycleId}/${unknownId()}.mp3`,
      qRow.storage_path,
    ]) {
      const copied = await bucket.copy(uploadedPath, destination)
      expect(copied.error, `copy to ${destination}`).not.toBeNull()
    }

    expect(await download(a.client, uploadedPath)).toEqual(bytes(16))
    expect(await download(a.client, pending.storage_path)).toBeNull()
    expect(await download(roleCast.nonMember.client, qRow.storage_path)).toBe(
      null,
    )
  })

  it('a size or type mismatch completes to rejected; an "already exists" retry then completes to uploaded', async () => {
    const { owner: a, cycleId } = await setup()

    const big = await registered(a, cycleId, 'big.mp3', 16)
    expect(
      await signedUpload(
        a.client,
        big.storage_path,
        new Blob([bytes(32)], { type: 'audio/mpeg' }),
      ),
    ).toBeNull()
    expect(
      expectRows(await completeUpload(a.client, big.upload_id), 1),
    ).toEqual([
      {
        upload_id: big.upload_id,
        status: 'rejected',
        error_code: 'upload_file_mismatch',
      },
    ])

    const typed = await registered(a, cycleId, 'typed.mp3', 16)
    expect(
      await signedUpload(
        a.client,
        typed.storage_path,
        new Blob([bytes(16)], { type: 'text/plain' }),
      ),
    ).toBeNull()
    expect(
      expectRows(await completeUpload(a.client, typed.upload_id), 1)[0],
    ).toMatchObject({ status: 'rejected', error_code: 'upload_file_mismatch' })

    const retry = await registered(a, cycleId, 'retry.mp3', 16)
    const body = new Blob([bytes(16)], { type: 'audio/mpeg' })
    expect(await signedUpload(a.client, retry.storage_path, body)).toBeNull()
    // The completion was lost; the browser retries the upload.
    const again = await signedUpload(a.client, retry.storage_path, body)
    expect(again).not.toBeNull()
    expectPgError(
      await completeUpload(a.client, unknownId()),
      'P0001',
      'upload_not_found',
    )
    expect(
      expectRows(await completeUpload(a.client, retry.upload_id), 1)[0],
    ).toMatchObject({ status: 'uploaded', error_code: null })
  })

  it('after A transfers the role to D, D reads and completes A’s upload and A can do neither', async () => {
    const roles = await setup()
    const { owner: a, memberB: d, cycleId } = roles
    const done = await uploadedFile(a, cycleId)
    const pending = await registered(a, cycleId, 'handover.mp3', 16)
    expect(
      await signedUpload(
        a.client,
        pending.storage_path,
        new Blob([bytes(16)], { type: 'audio/mpeg' }),
      ),
    ).toBeNull()

    await makeFacilitator(roles.project, a, d)

    expectPgError(
      await completeUpload(a.client, pending.upload_id),
      '42501',
      'not_project_facilitator',
    )
    expect(await download(a.client, done)).toBeNull()
    expect(
      (await a.client.storage.from(BUCKET).createSignedUrl(done, 60)).error,
    ).not.toBeNull()

    expect(
      expectRows(await completeUpload(d.client, pending.upload_id), 1)[0],
    ).toMatchObject({ status: 'uploaded' })
    expect(await download(d.client, done)).toEqual(bytes(16))
    expect(await download(d.client, pending.storage_path)).toEqual(bytes(16))
    await closeCycle(d, cycleId)

    // After close_cycle the facilitator still registers and completes.
    const late = await registered(d, cycleId, 'late.txt', 4, 'transcript_file')
    expect(late.mime_type).toBe('text/plain')
    expect(
      await signedUpload(
        d.client,
        late.storage_path,
        new Blob([bytes(4)], { type: 'text/plain' }),
      ),
    ).toBeNull()
    expect(
      expectRows(await completeUpload(d.client, late.upload_id), 1)[0],
    ).toMatchObject({ status: 'uploaded' })
  })
})
