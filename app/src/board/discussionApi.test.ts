import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

// The shared discussion mock replaces this module's calls; load a fresh copy
// of the real one that sees this file's supabaseClient mock.
vi.resetModules()
const {
  addNote,
  deleteNote,
  fetchDiscussion,
  setDiscussionStatus,
  updateNote,
} = await vi.importActual<typeof import('./discussionApi')>('./discussionApi')
const { DiscussionApiError, discussionErrorCodeOf } =
  await vi.importActual<typeof import('./discussionErrors')>(
    './discussionErrors',
  )

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const X = 'c1000000-0000-4000-8000-000000000001'
const Y = 'a1000000-0000-4000-8000-000000000002'
const N1 = 'e1000000-0000-4000-8000-000000000001'
const N2 = 'e1000000-0000-4000-8000-000000000002'
const T = '2026-11-03T12:34:56.123456+00:00'

function createClientMock(result: DbResult | (() => Promise<DbResult>)) {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<DbResult>
  >(typeof result === 'function' ? result : () => Promise.resolve(result))
  const from = vi.fn()
  state.client = { rpc, from }
  return { rpc, from }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(DiscussionApiError)
  expect((error as Error).message).toBe(discussionErrorCodeOf(error))
  return discussionErrorCodeOf(error)
}

function noteRow(overrides: Record<string, unknown> = {}) {
  return {
    note_id: N1,
    cluster_id: X,
    text: 'Line one\nline two',
    author_name: 'Bob',
    is_mine: true,
    created_at: T,
    edited_at: null,
    ...overrides,
  }
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    cycle_id: CYCLE_ID,
    statuses: [
      { cluster_id: X, discussion_status: 'discussed' },
      { cluster_id: Y, discussion_status: 'pending' },
    ],
    notes: [
      noteRow(),
      noteRow({
        note_id: N2,
        cluster_id: null,
        author_name: null,
        is_mine: false,
        edited_at: T,
      }),
    ],
    ...overrides,
  }
}

function omit(
  row: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => k !== key))
}

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('fetchDiscussion', () => {
  it('calls get_cycle_discussion once with exactly { p_cycle_id } and parses a valid response', async () => {
    const fake = createClientMock({ data: response(), error: null })

    await expect(fetchDiscussion(CYCLE_ID)).resolves.toStrictEqual({
      cycleId: CYCLE_ID,
      statuses: [
        { clusterId: X, discussionStatus: 'discussed' },
        { clusterId: Y, discussionStatus: 'pending' },
      ],
      notes: [
        {
          noteId: N1,
          clusterId: X,
          text: 'Line one\nline two',
          authorName: 'Bob',
          isMine: true,
          createdAt: T,
          editedAt: null,
        },
        {
          noteId: N2,
          clusterId: null,
          text: 'Line one\nline two',
          authorName: null,
          isMine: false,
          createdAt: T,
          editedAt: T,
        },
      ],
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls[0]?.[0]).toBe('get_cycle_discussion')
    expect(fake.rpc.mock.calls[0]?.[1]).toStrictEqual({ p_cycle_id: CYCLE_ID })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('accepts empty statuses and notes, 2000 code points, and a Z timestamp', async () => {
    createClientMock({
      data: response({
        statuses: [],
        notes: [
          noteRow({
            cluster_id: null,
            text: '😀'.repeat(2000),
            created_at: '2026-11-03T12:00:00Z',
          }),
        ],
      }),
      error: null,
    })
    const result = await fetchDiscussion(CYCLE_ID)
    expect(result.statuses).toEqual([])
    expect(result.notes).toHaveLength(1)
  })

  it.each([
    ['an extra top-level key', { ...response(), extra: 1 }],
    ['a missing top-level key', omit(response(), 'notes')],
    ['another cycle id', response({ cycle_id: 'other' })],
    [
      'an extra status key',
      response({
        statuses: [{ cluster_id: X, discussion_status: 'pending', sort: 1 }],
      }),
    ],
    ['a missing status key', response({ statuses: [{ cluster_id: X }] })],
    [
      'an unknown status value',
      response({ statuses: [{ cluster_id: X, discussion_status: 'done' }] }),
    ],
    ['an extra note key', response({ notes: [noteRow({ author_id: 'u' })] })],
    [
      'a missing note key',
      response({
        notes: [omit(noteRow(), 'edited_at')],
      }),
    ],
    ['empty text', response({ notes: [noteRow({ text: '' })] })],
    [
      '2001 characters',
      response({ notes: [noteRow({ text: 'a'.repeat(2001) })] }),
    ],
    [
      '2001 code points',
      response({ notes: [noteRow({ text: '😀'.repeat(2001) })] }),
    ],
    [
      'a non-boolean is_mine',
      response({ notes: [noteRow({ is_mine: 'yes' })] }),
    ],
    [
      'a numeric author_name',
      response({ notes: [noteRow({ author_name: 1 })] }),
    ],
    ['a numeric cluster_id', response({ notes: [noteRow({ cluster_id: 1 })] })],
    [
      'a bad created_at',
      response({ notes: [noteRow({ created_at: 'yesterday' })] }),
    ],
    [
      'a bad edited_at',
      response({ notes: [noteRow({ edited_at: '2026-11-03' })] }),
    ],
    ['non-array statuses', response({ statuses: {} })],
    ['non-array notes', response({ notes: 'none' })],
    ['an array', [response()]],
    ['null', null],
  ])('%s is unknown', async (_label, data) => {
    createClientMock({ data, error: null })
    expect(await codeOf(fetchDiscussion(CYCLE_ID))).toBe('unknown')
  })

  it('a thrown call, a missing client, and an RPC error keep only the code', async () => {
    createClientMock(() => Promise.reject(new Error('network down')))
    expect(await codeOf(fetchDiscussion(CYCLE_ID))).toBe('unknown')

    state.client = null
    expect(await codeOf(fetchDiscussion(CYCLE_ID))).toBe('unknown')

    createClientMock({
      data: null,
      error: { message: 'not_project_member', code: '42501' },
    })
    expect(await codeOf(fetchDiscussion(CYCLE_ID))).toBe('not_project_member')

    createClientMock({
      data: null,
      error: { message: 'permission denied for table notes', code: '42501' },
    })
    const error = await fetchDiscussion(CYCLE_ID).catch(
      (reason: unknown) => reason,
    )
    expect(discussionErrorCodeOf(error)).toBe('unknown')
    expect(JSON.stringify(error)).not.toContain('permission')
    expect(String(error)).not.toContain('permission')
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
  })
})

describe('writes', () => {
  it('setDiscussionStatus calls set_discussion_status once with exactly { p_cluster_id, p_status }', async () => {
    const fake = createClientMock({
      data: [{ cluster_id: X, discussion_status: 'skipped' }],
      error: null,
    })
    await expect(setDiscussionStatus(X, 'skipped')).resolves.toBeUndefined()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls[0]?.[0]).toBe('set_discussion_status')
    expect(fake.rpc.mock.calls[0]?.[1]).toStrictEqual({
      p_cluster_id: X,
      p_status: 'skipped',
    })
  })

  it('addNote calls add_note once with exactly { p_cycle_id, p_cluster_id, p_text }', async () => {
    const fake = createClientMock({
      data: [{ note_id: N1, cluster_id: X }],
      error: null,
    })
    await expect(addNote(CYCLE_ID, X, 'hello')).resolves.toBe(N1)
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls[0]?.[0]).toBe('add_note')
    expect(fake.rpc.mock.calls[0]?.[1]).toStrictEqual({
      p_cycle_id: CYCLE_ID,
      p_cluster_id: X,
      p_text: 'hello',
    })
  })

  it('a general note passes p_cluster_id null', async () => {
    const fake = createClientMock({
      data: [{ note_id: N1, cluster_id: null }],
      error: null,
    })
    await expect(addNote(CYCLE_ID, null, 'hello')).resolves.toBe(N1)
    expect(fake.rpc.mock.calls[0]?.[1]).toStrictEqual({
      p_cycle_id: CYCLE_ID,
      p_cluster_id: null,
      p_text: 'hello',
    })
  })

  it('updateNote calls update_note once with exactly { p_note_id, p_text }', async () => {
    const fake = createClientMock({ data: [{ note_id: N1 }], error: null })
    await expect(updateNote(N1, 'changed')).resolves.toBeUndefined()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls[0]?.[0]).toBe('update_note')
    expect(fake.rpc.mock.calls[0]?.[1]).toStrictEqual({
      p_note_id: N1,
      p_text: 'changed',
    })
  })

  it('deleteNote calls delete_note once with exactly { p_note_id }', async () => {
    const fake = createClientMock({ data: [{ note_id: N1 }], error: null })
    await expect(deleteNote(N1)).resolves.toBeUndefined()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls[0]?.[0]).toBe('delete_note')
    expect(fake.rpc.mock.calls[0]?.[1]).toStrictEqual({ p_note_id: N1 })
  })

  it.each([
    [
      'a different status',
      () => setDiscussionStatus(X, 'skipped'),
      [{ cluster_id: X, discussion_status: 'deferred' }],
    ],
    [
      'a different cluster',
      () => setDiscussionStatus(X, 'skipped'),
      [{ cluster_id: Y, discussion_status: 'skipped' }],
    ],
    ['zero status rows', () => setDiscussionStatus(X, 'skipped'), []],
    [
      'two status rows',
      () => setDiscussionStatus(X, 'skipped'),
      [
        { cluster_id: X, discussion_status: 'skipped' },
        { cluster_id: X, discussion_status: 'skipped' },
      ],
    ],
    [
      'an extra status column',
      () => setDiscussionStatus(X, 'skipped'),
      [{ cluster_id: X, discussion_status: 'skipped', updated_at: T }],
    ],
    [
      'an add for a different cluster',
      () => addNote(CYCLE_ID, X, 'hi'),
      [{ note_id: N1, cluster_id: Y }],
    ],
    [
      'an add returning a cluster for a general note',
      () => addNote(CYCLE_ID, null, 'hi'),
      [{ note_id: N1, cluster_id: X }],
    ],
    ['zero add rows', () => addNote(CYCLE_ID, X, 'hi'), []],
    [
      'two add rows',
      () => addNote(CYCLE_ID, X, 'hi'),
      [
        { note_id: N1, cluster_id: X },
        { note_id: N2, cluster_id: X },
      ],
    ],
    [
      'an update of a different note',
      () => updateNote(N1, 'x'),
      [{ note_id: N2 }],
    ],
    ['zero update rows', () => updateNote(N1, 'x'), []],
    [
      'two update rows',
      () => updateNote(N1, 'x'),
      [{ note_id: N1 }, { note_id: N1 }],
    ],
    ['a delete of a different note', () => deleteNote(N1), [{ note_id: N2 }]],
    ['zero delete rows', () => deleteNote(N1), []],
    ['a delete returning null', () => deleteNote(N1), null],
  ])('%s is unknown', async (_label, call, data) => {
    createClientMock({ data, error: null })
    expect(await codeOf(call())).toBe('unknown')
  })

  it.each([
    ['setDiscussionStatus', () => setDiscussionStatus(X, 'skipped')],
    ['addNote', () => addNote(CYCLE_ID, X, 'hi')],
    ['updateNote', () => updateNote(N1, 'x')],
    ['deleteNote', () => deleteNote(N1)],
  ])(
    '%s: a thrown call is unknown and a coded error keeps its code',
    async (_label, call) => {
      createClientMock(() => Promise.reject(new Error('boom')))
      expect(await codeOf(call())).toBe('unknown')

      createClientMock({
        data: null,
        error: { message: 'cycle_not_discussing', code: 'P0001' },
      })
      expect(await codeOf(call())).toBe('cycle_not_discussing')

      state.client = null
      expect(await codeOf(call())).toBe('unknown')
    },
  )
})
