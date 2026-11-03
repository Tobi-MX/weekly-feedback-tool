import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

// The shared actions mock replaces this module's calls; load a fresh copy of
// the real one that sees this file's supabaseClient mock.
vi.resetModules()
const {
  createAction,
  deleteAction,
  fetchCycleActions,
  setActionStatus,
  updateAction,
} = await vi.importActual<typeof import('./actionsApi')>('./actionsApi')
const { ActionApiError, actionErrorCodeOf } =
  await vi.importActual<typeof import('./actionErrors')>('./actionErrors')

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const X = 'c1000000-0000-4000-8000-000000000001'
const A1 = 'a1000000-0000-4000-8000-000000000001'
const A2 = 'a1000000-0000-4000-8000-000000000002'
const D = 'd1000000-0000-4000-8000-000000000004'
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
  expect(error).toBeInstanceOf(ActionApiError)
  expect((error as Error).message).toBe(actionErrorCodeOf(error))
  return actionErrorCodeOf(error)
}

function actionRow(overrides: Record<string, unknown> = {}) {
  return {
    action_id: A1,
    cluster_id: X,
    description: 'Write the runbook\nfirst draft',
    owner_id: D,
    owner_name: 'Dan',
    owner_is_me: false,
    created_by_me: true,
    due_date: '2026-11-12',
    status: 'open',
    completed_at: null,
    source: 'manual',
    created_at: T,
    updated_at: T,
    ...overrides,
  }
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    cycle_id: CYCLE_ID,
    actions: [
      actionRow(),
      actionRow({
        action_id: A2,
        cluster_id: null,
        owner_id: null,
        owner_name: null,
        owner_is_me: false,
        created_by_me: false,
        due_date: null,
        status: 'done',
        completed_at: T,
        source: 'extraction',
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

const INPUT = {
  description: 'Write the runbook',
  ownerId: D,
  dueDate: '2026-11-12',
  clusterId: X,
}

beforeEach(() => {
  state.client = null
})

describe('fetchCycleActions', () => {
  it('calls get_cycle_actions once with exactly { p_cycle_id } and parses a valid response', async () => {
    const fake = createClientMock({ data: response(), error: null })

    await expect(fetchCycleActions(CYCLE_ID)).resolves.toStrictEqual({
      cycleId: CYCLE_ID,
      actions: [
        {
          actionId: A1,
          clusterId: X,
          description: 'Write the runbook\nfirst draft',
          ownerId: D,
          ownerName: 'Dan',
          ownerIsMe: false,
          createdByMe: true,
          dueDate: '2026-11-12',
          status: 'open',
          completedAt: null,
          source: 'manual',
          createdAt: T,
          updatedAt: T,
        },
        {
          actionId: A2,
          clusterId: null,
          description: 'Write the runbook\nfirst draft',
          ownerId: null,
          ownerName: null,
          ownerIsMe: false,
          createdByMe: false,
          dueDate: null,
          status: 'done',
          completedAt: T,
          source: 'extraction',
          createdAt: T,
          updatedAt: T,
        },
      ],
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('get_cycle_actions', {
      p_cycle_id: CYCLE_ID,
    })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('parses an empty list, 500 code points, and HTML-like text', async () => {
    createClientMock({
      data: response({
        actions: [
          actionRow({ description: '😀'.repeat(500) }),
          actionRow({ action_id: A2, description: '<b>x</b>' }),
        ],
      }),
      error: null,
    })
    const parsed = await fetchCycleActions(CYCLE_ID)
    expect(parsed.actions.map((action) => action.description)).toEqual([
      '😀'.repeat(500),
      '<b>x</b>',
    ])

    createClientMock({ data: response({ actions: [] }), error: null })
    await expect(fetchCycleActions(CYCLE_ID)).resolves.toStrictEqual({
      cycleId: CYCLE_ID,
      actions: [],
    })
  })

  const ACTION_KEYS = Object.keys(actionRow())

  it.each<[string, unknown]>([
    ['a missing top-level key', omit(response(), 'actions')],
    ['an extra top-level key', { ...response(), extra: 1 }],
    ['another cycle id', response({ cycle_id: X })],
    ['actions that are not an array', response({ actions: {} })],
    ['a non-object response', 'nope'],
    ['a null response', null],
    ['an array response', [response()]],
    ...ACTION_KEYS.map(
      (key) =>
        [
          `an action missing ${key}`,
          response({ actions: [omit(actionRow(), key)] }),
        ] as [string, unknown],
    ),
    [
      'an action with an extra key',
      response({ actions: [{ ...actionRow(), created_by: D }] }),
    ],
    [
      'an unknown status',
      response({ actions: [actionRow({ status: 'blocked' })] }),
    ],
    [
      'an unknown source',
      response({ actions: [actionRow({ source: 'import' })] }),
    ],
    [
      'an empty description',
      response({ actions: [actionRow({ description: '' })] }),
    ],
    [
      'a 501-character description',
      response({ actions: [actionRow({ description: 'a'.repeat(501) })] }),
    ],
    [
      'owner_name null with owner_id set',
      response({ actions: [actionRow({ owner_name: null })] }),
    ],
    [
      'owner_name set with owner_id null',
      response({ actions: [actionRow({ owner_id: null })] }),
    ],
    [
      'completed_at on an open action',
      response({ actions: [actionRow({ completed_at: T })] }),
    ],
    [
      'no completed_at on a done action',
      response({ actions: [actionRow({ status: 'done' })] }),
    ],
    [
      'a non-boolean owner_is_me',
      response({ actions: [actionRow({ owner_is_me: 'true' })] }),
    ],
    [
      'a non-boolean created_by_me',
      response({ actions: [actionRow({ created_by_me: 1 })] }),
    ],
    [
      'a due date with a time',
      response({ actions: [actionRow({ due_date: '2026-11-12T00:00:00Z' })] }),
    ],
    [
      'a due date that is not a calendar date',
      response({ actions: [actionRow({ due_date: '2026-13-40' })] }),
    ],
    [
      'a due date in another format',
      response({ actions: [actionRow({ due_date: '11/12/2026' })] }),
    ],
    [
      'a bad created_at',
      response({ actions: [actionRow({ created_at: 'yesterday' })] }),
    ],
    [
      'a bad updated_at',
      response({ actions: [actionRow({ updated_at: 12 })] }),
    ],
    [
      'a bad completed_at',
      response({
        actions: [actionRow({ status: 'done', completed_at: 'now' })],
      }),
    ],
    [
      'a numeric cluster_id',
      response({ actions: [actionRow({ cluster_id: 5 })] }),
    ],
  ])('%s is unknown', async (_label, data) => {
    createClientMock({ data, error: null })
    expect(await codeOf(fetchCycleActions(CYCLE_ID))).toBe('unknown')
  })

  it('maps a raised code and keeps no server text', async () => {
    createClientMock({
      data: null,
      error: { message: 'not_project_member', code: '42501' },
    })
    expect(await codeOf(fetchCycleActions(CYCLE_ID))).toBe('not_project_member')
  })

  it('a thrown call and a missing client are unknown', async () => {
    createClientMock(() => Promise.reject(new Error('network down')))
    expect(await codeOf(fetchCycleActions(CYCLE_ID))).toBe('unknown')
    state.client = null
    expect(await codeOf(fetchCycleActions(CYCLE_ID))).toBe('unknown')
  })
})

describe('createAction', () => {
  it('calls create_action once with exactly the five keys and returns the id', async () => {
    const fake = createClientMock({ data: [{ action_id: A1 }], error: null })
    await expect(createAction(CYCLE_ID, INPUT)).resolves.toBe(A1)
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('create_action', {
      p_cycle_id: CYCLE_ID,
      p_description: 'Write the runbook',
      p_owner_id: D,
      p_due_date: '2026-11-12',
      p_cluster_id: X,
    })
  })

  it('passes a missing due date and topic as null', async () => {
    const fake = createClientMock({ data: [{ action_id: A1 }], error: null })
    await createAction(CYCLE_ID, { ...INPUT, dueDate: null, clusterId: null })
    expect(fake.rpc).toHaveBeenCalledWith('create_action', {
      p_cycle_id: CYCLE_ID,
      p_description: 'Write the runbook',
      p_owner_id: D,
      p_due_date: null,
      p_cluster_id: null,
    })
  })

  it.each<[string, unknown]>([
    ['zero rows', []],
    ['two rows', [{ action_id: A1 }, { action_id: A2 }]],
    ['an extra key', [{ action_id: A1, status: 'open' }]],
    ['a missing id', [{}]],
    ['a non-array', { action_id: A1 }],
  ])('%s is unknown', async (_label, data) => {
    createClientMock({ data, error: null })
    expect(await codeOf(createAction(CYCLE_ID, INPUT))).toBe('unknown')
  })

  it('maps every raised code and a thrown call', async () => {
    for (const code of [
      'not_project_member',
      'cycle_not_discussing',
      'cluster_not_found',
      'invalid_action_description',
      'invalid_action_owner',
      'invalid_due_date',
      'action_limit_reached',
    ]) {
      createClientMock({ data: null, error: { message: code } })
      expect(await codeOf(createAction(CYCLE_ID, INPUT))).toBe(code)
    }
    createClientMock(() => Promise.reject(new Error('down')))
    expect(await codeOf(createAction(CYCLE_ID, INPUT))).toBe('unknown')
  })
})

describe('updateAction', () => {
  it('calls update_action once with exactly the five keys', async () => {
    const fake = createClientMock({ data: [{ action_id: A1 }], error: null })
    await expect(
      updateAction(A1, { ...INPUT, dueDate: null, clusterId: null }),
    ).resolves.toBeUndefined()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('update_action', {
      p_action_id: A1,
      p_description: 'Write the runbook',
      p_owner_id: D,
      p_due_date: null,
      p_cluster_id: null,
    })
  })

  it.each<[string, unknown]>([
    ['a different id', [{ action_id: A2 }]],
    ['zero rows', []],
    ['two rows', [{ action_id: A1 }, { action_id: A1 }]],
  ])('%s is unknown', async (_label, data) => {
    createClientMock({ data, error: null })
    expect(await codeOf(updateAction(A1, INPUT))).toBe('unknown')
  })

  it('maps not_action_editor and action_not_found', async () => {
    createClientMock({ data: null, error: { message: 'not_action_editor' } })
    expect(await codeOf(updateAction(A1, INPUT))).toBe('not_action_editor')
    createClientMock({ data: null, error: { message: 'action_not_found' } })
    expect(await codeOf(updateAction(A1, INPUT))).toBe('action_not_found')
  })
})

describe('setActionStatus', () => {
  it('calls set_action_status once with exactly { p_action_id, p_status }', async () => {
    const fake = createClientMock({
      data: [{ action_id: A1, status: 'done' }],
      error: null,
    })
    await expect(setActionStatus(A1, 'done')).resolves.toBeUndefined()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('set_action_status', {
      p_action_id: A1,
      p_status: 'done',
    })
  })

  it.each<[string, unknown]>([
    ['a different status', [{ action_id: A1, status: 'open' }]],
    ['a different id', [{ action_id: A2, status: 'done' }]],
    ['a missing status', [{ action_id: A1 }]],
    ['zero rows', []],
    [
      'two rows',
      [
        { action_id: A1, status: 'done' },
        { action_id: A1, status: 'done' },
      ],
    ],
  ])('%s is unknown', async (_label, data) => {
    createClientMock({ data, error: null })
    expect(await codeOf(setActionStatus(A1, 'done'))).toBe('unknown')
  })

  it('maps not_action_owner', async () => {
    createClientMock({ data: null, error: { message: 'not_action_owner' } })
    expect(await codeOf(setActionStatus(A1, 'open'))).toBe('not_action_owner')
  })
})

describe('deleteAction', () => {
  it('calls delete_action once with exactly { p_action_id }', async () => {
    const fake = createClientMock({ data: [{ action_id: A1 }], error: null })
    await expect(deleteAction(A1)).resolves.toBeUndefined()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('delete_action', { p_action_id: A1 })
  })

  it.each<[string, unknown]>([
    ['a different id', [{ action_id: A2 }]],
    ['zero rows', []],
    ['two rows', [{ action_id: A1 }, { action_id: A1 }]],
  ])('%s is unknown', async (_label, data) => {
    createClientMock({ data, error: null })
    expect(await codeOf(deleteAction(A1))).toBe('unknown')
  })

  it('a missing client is unknown', async () => {
    state.client = null
    expect(await codeOf(deleteAction(A1))).toBe('unknown')
  })
})
