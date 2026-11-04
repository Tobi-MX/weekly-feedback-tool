import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectActionFilters } from './projectActionsApi'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

// The shared project actions mock replaces this module's call; load a fresh
// copy of the real one that sees this file's supabaseClient mock.
vi.resetModules()
const { fetchProjectActions } = await vi.importActual<
  typeof import('./projectActionsApi')
>('./projectActionsApi')
const { ActionApiError, actionErrorCodeOf } = await vi.importActual<
  typeof import('../board/actionErrors')
>('../board/actionErrors')

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const X = 'c1000000-0000-4000-8000-000000000001'
const D = 'd1000000-0000-4000-8000-000000000004'
const T = '2026-11-03T12:34:56.123456+00:00'

const ALL: ProjectActionFilters = { status: 'all', mineOnly: false }

function createClientMock(result: DbResult | (() => Promise<DbResult>)) {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<DbResult>
  >(typeof result === 'function' ? result : () => Promise.resolve(result))
  const from = vi.fn()
  state.client = { rpc, from }
  return { rpc, from }
}

function id(n: number): string {
  return `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function element(overrides: Record<string, unknown> = {}) {
  return {
    action_id: id(1),
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
    cycle_id: CYCLE_ID,
    cycle_title: 'Week of Oct 26, 2026',
    cycle_status: 'discuss',
    cluster_name: 'Testing',
    ...overrides,
  }
}

function doneElement(overrides: Record<string, unknown> = {}) {
  return element({
    action_id: id(2),
    status: 'done',
    completed_at: T,
    cluster_id: null,
    cluster_name: null,
    ...overrides,
  })
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    status: 'all',
    mine_only: false,
    open_count: 1,
    done_count: 1,
    open: [element()],
    done: [doneElement()],
    ...overrides,
  }
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

beforeEach(() => {
  state.client = null
})

describe('fetchProjectActions', () => {
  it('calls get_project_actions once with exactly the three arguments', async () => {
    const { rpc, from } = createClientMock({ data: response(), error: null })

    await fetchProjectActions(PROJECT_ID, ALL)

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_project_actions', {
      p_project_id: PROJECT_ID,
      p_status: 'all',
      p_mine_only: false,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'open', mineOnly: true },
    { status: 'done', mineOnly: false },
  ] as const)('sends the filters $status / $mineOnly', async (filters) => {
    const { rpc } = createClientMock({
      data: response({
        status: filters.status,
        mine_only: filters.mineOnly,
        open: filters.status === 'done' ? [] : [element()],
        done: filters.status === 'open' ? [] : [doneElement()],
      }),
      error: null,
    })

    await fetchProjectActions(PROJECT_ID, filters)

    expect(rpc).toHaveBeenCalledWith('get_project_actions', {
      p_project_id: PROJECT_ID,
      p_status: filters.status,
      p_mine_only: filters.mineOnly,
    })
  })

  it('parses a valid response', async () => {
    createClientMock({ data: response(), error: null })

    await expect(fetchProjectActions(PROJECT_ID, ALL)).resolves.toEqual({
      projectId: PROJECT_ID,
      status: 'all',
      mineOnly: false,
      openCount: 1,
      doneCount: 1,
      open: [
        {
          actionId: id(1),
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
          cycleId: CYCLE_ID,
          cycleTitle: 'Week of Oct 26, 2026',
          cycleStatus: 'discuss',
          clusterName: 'Testing',
        },
      ],
      done: [
        expect.objectContaining({
          actionId: id(2),
          status: 'done',
          completedAt: T,
          clusterId: null,
          clusterName: null,
        }),
      ],
    })
  })

  it('parses a deleted owner, an extraction action and a closed cycle', async () => {
    createClientMock({
      data: response({
        open: [
          element({
            owner_id: null,
            owner_name: null,
            source: 'extraction',
            cycle_status: 'closed',
            due_date: null,
          }),
        ],
      }),
      error: null,
    })

    const body = await fetchProjectActions(PROJECT_ID, ALL)
    expect(body.open[0]).toMatchObject({
      ownerId: null,
      ownerName: null,
      source: 'extraction',
      cycleStatus: 'closed',
      dueDate: null,
    })
  })

  it('parses the limits: 200 open and 20 done below larger counts', async () => {
    createClientMock({
      data: response({
        open_count: 201,
        done_count: 25,
        open: Array.from({ length: 200 }, (_, i) =>
          element({ action_id: id(i + 1) }),
        ),
        done: Array.from({ length: 20 }, (_, i) =>
          doneElement({ action_id: id(1000 + i) }),
        ),
      }),
      error: null,
    })

    const body = await fetchProjectActions(PROJECT_ID, ALL)
    expect(body.open).toHaveLength(200)
    expect(body.done).toHaveLength(20)
  })

  const invalid: readonly (readonly [
    string,
    unknown,
    ProjectActionFilters?,
  ])[] = [
    [
      'a missing top-level key',
      (() => {
        const { done_count: _omit, ...rest } = response()
        void _omit
        return rest
      })(),
    ],
    ['an extra top-level key', response({ extra: 1 })],
    [
      'a missing element key',
      response({
        open: [
          (() => {
            const { cluster_name: _omit, ...rest } = element()
            void _omit
            return rest
          })(),
        ],
      }),
    ],
    ['an extra element key', response({ open: [element({ created_by: D })] })],
    [
      'status different from the request',
      response({ status: 'open', done: [] }),
    ],
    ['mine_only different from the request', response({ mine_only: true })],
    ['a project id different from the request', response({ project_id: X })],
    ['a negative count', response({ open_count: -1, open: [] })],
    ['a non-integer count', response({ done_count: 1.5 })],
    ['a string count', response({ done_count: '1' })],
    [
      'a non-empty open for a done request',
      response({ status: 'done' }),
      { status: 'done', mineOnly: false },
    ],
    [
      'a non-empty done for an open request',
      response({ status: 'open' }),
      { status: 'open', mineOnly: false },
    ],
    [
      'more than 200 open elements',
      response({
        open_count: 300,
        open: Array.from({ length: 201 }, (_, i) =>
          element({ action_id: id(i + 1) }),
        ),
      }),
    ],
    [
      'more than 20 done elements',
      response({
        done_count: 30,
        done: Array.from({ length: 21 }, (_, i) =>
          doneElement({ action_id: id(1000 + i) }),
        ),
      }),
    ],
    ['an open list longer than its count', response({ open_count: 0 })],
    ['a done list longer than its count', response({ done_count: 0 })],
    [
      'a done element in open',
      response({ open: [doneElement({ action_id: id(5) })], open_count: 1 }),
    ],
    [
      'an open element in done',
      response({ done: [element({ action_id: id(5) })] }),
    ],
    [
      'cluster_name set with cluster_id null',
      response({ open: [element({ cluster_id: null })] }),
    ],
    [
      'cluster_id set with cluster_name null',
      response({ open: [element({ cluster_name: null })] }),
    ],
    [
      'an unknown cycle_status',
      response({ open: [element({ cycle_status: 'archived' })] }),
    ],
    [
      'an empty cycle_title',
      response({ open: [element({ cycle_title: '' })] }),
    ],
    ['a non-string cycle_id', response({ open: [element({ cycle_id: 1 })] })],
    [
      'owner_id null with a name',
      response({ open: [element({ owner_id: null })] }),
    ],
    [
      'owner_name null with an owner',
      response({ open: [element({ owner_name: null })] }),
    ],
    [
      'done without completed_at',
      response({ done: [doneElement({ completed_at: null })] }),
    ],
    [
      'open with completed_at',
      response({ open: [element({ completed_at: T })] }),
    ],
    [
      'an empty description',
      response({ open: [element({ description: '' })] }),
    ],
    [
      'a 501-character description',
      response({ open: [element({ description: 'x'.repeat(501) })] }),
    ],
    [
      'a malformed due date',
      response({ open: [element({ due_date: '2026-13-40' })] }),
    ],
    ['an unknown source', response({ open: [element({ source: 'ai' })] })],
    [
      'a malformed timestamp',
      response({ open: [element({ created_at: 'yesterday' })] }),
    ],
    [
      'a non-boolean owner_is_me',
      response({ open: [element({ owner_is_me: 'yes' })] }),
    ],
    [
      'an action_id repeated within a list',
      response({ open_count: 2, open: [element(), element()] }),
    ],
    [
      'an action_id repeated across both lists',
      response({ done: [doneElement({ action_id: id(1) })] }),
    ],
    ['a non-object', [response()]],
    ['null', null],
    ['a string', 'ok'],
  ]

  it.each(
    invalid.map(([name, data, filters]) => ({
      name,
      data,
      filters: filters ?? ALL,
    })),
  )('$name is unknown', async ({ data, filters }) => {
    createClientMock({ data, error: null })
    expect(await codeOf(fetchProjectActions(PROJECT_ID, filters))).toBe(
      'unknown',
    )
  })

  it('a thrown call is unknown', async () => {
    createClientMock(() => Promise.reject(new Error('network down')))
    expect(await codeOf(fetchProjectActions(PROJECT_ID, ALL))).toBe('unknown')
  })

  it('a missing client is unknown', async () => {
    state.client = null
    expect(await codeOf(fetchProjectActions(PROJECT_ID, ALL))).toBe('unknown')
  })

  it.each(['not_project_member', 'invalid_action_filter'] as const)(
    '%s maps to itself',
    async (message) => {
      createClientMock({
        data: null,
        error: {
          message,
          code: message === 'not_project_member' ? '42501' : 'P0001',
        },
      })
      expect(await codeOf(fetchProjectActions(PROJECT_ID, ALL))).toBe(message)
    },
  )

  it('any other server message is unknown, and its text is not kept', async () => {
    createClientMock({
      data: null,
      error: { message: 'permission denied for table actions' },
    })
    const error = await fetchProjectActions(PROJECT_ID, ALL).catch(
      (reason: unknown) => reason,
    )
    expect(actionErrorCodeOf(error)).toBe('unknown')
    expect(JSON.stringify(error)).not.toContain('permission')
    expect((error as Error).message).toBe('unknown')
  })
})
