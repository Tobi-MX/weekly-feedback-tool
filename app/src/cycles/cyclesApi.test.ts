import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CyclesApiError,
  closeCycleErrorMessage,
  createCycleErrorMessage,
  startRetrospectiveErrorMessage,
  toCyclesErrorCode,
  type CyclesErrorCode,
} from './cyclesErrors'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

const {
  fetchProjectCycles,
  fetchCycle,
  createCycle,
  closeCycle,
  fetchCycleStatus,
  startRetrospective,
} = await vi.importActual<typeof import('./cyclesApi')>('./cyclesApi')

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

type Call = readonly [method: string, ...args: unknown[]]

const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const COLUMNS = 'id, title, week_start, status, created_at, closed_at'

const openRow = {
  id: CYCLE_ID,
  title: 'Week of Oct 26, 2026',
  week_start: '2026-10-26',
  status: 'collecting',
  created_at: '2026-10-30T12:00:00+00:00',
  closed_at: null,
}

const closedRow = {
  id: '30000000-0000-4000-8000-000000000002',
  title: 'Week of Oct 19, 2026',
  week_start: '2026-10-19',
  status: 'closed',
  created_at: '2026-10-20T12:00:00+00:00',
  closed_at: '2026-10-24T12:00:00+00:00',
}

/**
 * A recording stand-in for the supabase-js query builder. Each `from()` call
 * gets its own chain, records every method call, and resolves to the next
 * queued result when awaited.
 */
function createClientMock(results: DbResult[]) {
  const chains: Call[][] = []
  const rpc =
    vi.fn<(name: string, args: Record<string, unknown>) => Promise<DbResult>>()

  const from = vi.fn((table: string) => {
    const calls: Call[] = [['from', table]]
    chains.push(calls)
    const result = results.shift() ?? { data: [], error: null }
    const builder = {
      select: (...args: unknown[]) => record('select', args),
      eq: (...args: unknown[]) => record('eq', args),
      neq: (...args: unknown[]) => record('neq', args),
      order: (...args: unknown[]) => record('order', args),
      limit: (...args: unknown[]) => record('limit', args),
      maybeSingle: (...args: unknown[]) => record('maybeSingle', args),
      then<T>(onFulfilled: (value: DbResult) => T): Promise<T> {
        return Promise.resolve(result).then(onFulfilled)
      },
    }
    function record(method: string, args: unknown[]) {
      calls.push([method, ...args])
      return builder
    }
    return builder
  })

  state.client = { from, rpc }
  return { from, rpc, chains }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
}

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('fetchProjectCycles', () => {
  it('reads the open cycle and the ten newest closed cycles of the project', async () => {
    const fake = createClientMock([
      { data: [openRow], error: null },
      { data: [closedRow], error: null },
    ])

    await expect(fetchProjectCycles(PROJECT_ID)).resolves.toEqual({
      current: {
        id: CYCLE_ID,
        title: 'Week of Oct 26, 2026',
        weekStart: '2026-10-26',
        status: 'collecting',
        createdAt: '2026-10-30T12:00:00+00:00',
        closedAt: null,
      },
      past: [
        {
          id: closedRow.id,
          title: 'Week of Oct 19, 2026',
          weekStart: '2026-10-19',
          status: 'closed',
          createdAt: '2026-10-20T12:00:00+00:00',
          closedAt: '2026-10-24T12:00:00+00:00',
        },
      ],
    })

    expect(fake.from).toHaveBeenCalledTimes(2)
    expect(fake.chains).toEqual([
      [
        ['from', 'feedback_cycles'],
        ['select', COLUMNS],
        ['eq', 'project_id', PROJECT_ID],
        ['neq', 'status', 'closed'],
        ['order', 'created_at', { ascending: false }],
        ['limit', 1],
      ],
      [
        ['from', 'feedback_cycles'],
        ['select', COLUMNS],
        ['eq', 'project_id', PROJECT_ID],
        ['eq', 'status', 'closed'],
        ['order', 'created_at', { ascending: false }],
        ['limit', 10],
      ],
    ])
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('returns no current cycle and an empty past list when there are none', async () => {
    createClientMock([
      { data: [], error: null },
      { data: [], error: null },
    ])

    await expect(fetchProjectCycles(PROJECT_ID)).resolves.toEqual({
      current: null,
      past: [],
    })
  })

  it('makes no request for a non-UUID project id', async () => {
    const fake = createClientMock([])

    await expect(fetchProjectCycles('project-1')).resolves.toEqual({
      current: null,
      past: [],
    })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('throws a coded error without the raw Postgres text', async () => {
    createClientMock([
      { data: null, error: { message: 'permission denied for table x' } },
      { data: [], error: null },
    ])

    const error = await captureError(fetchProjectCycles(PROJECT_ID))
    expect(error).toBeInstanceOf(CyclesApiError)
    expect((error as CyclesApiError).code).toBe('unknown')
    expect((error as CyclesApiError).message).not.toContain('permission')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('rejects a row with an unknown status', async () => {
    createClientMock([
      { data: [{ ...openRow, status: 'open' }], error: null },
      { data: [], error: null },
    ])

    await expect(fetchProjectCycles(PROJECT_ID)).rejects.toBeInstanceOf(
      CyclesApiError,
    )
  })

  it('throws when Supabase is not configured', async () => {
    await expect(fetchProjectCycles(PROJECT_ID)).rejects.toBeInstanceOf(
      CyclesApiError,
    )
  })
})

describe('fetchCycle', () => {
  const detailRow = {
    id: CYCLE_ID,
    project_id: PROJECT_ID,
    title: 'Week of Oct 26, 2026',
    week_start: '2026-10-26',
    status: 'collecting',
  }

  it('reads one cycle by id with only the five columns and maybeSingle', async () => {
    const fake = createClientMock([{ data: detailRow, error: null }])

    await expect(fetchCycle(CYCLE_ID)).resolves.toEqual({
      id: CYCLE_ID,
      projectId: PROJECT_ID,
      title: 'Week of Oct 26, 2026',
      weekStart: '2026-10-26',
      status: 'collecting',
    })
    expect(fake.chains).toEqual([
      [
        ['from', 'feedback_cycles'],
        ['select', 'id, project_id, title, week_start, status'],
        ['eq', 'id', CYCLE_ID],
        ['maybeSingle'],
      ],
    ])
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('drops columns it did not ask for', async () => {
    createClientMock([
      { data: { ...detailRow, created_by: 'user-9' }, error: null },
    ])

    const cycle = await fetchCycle(CYCLE_ID)
    expect(cycle).not.toHaveProperty('created_by')
    expect(cycle).not.toHaveProperty('createdBy')
  })

  it('returns null for zero rows (unknown id or not a member)', async () => {
    createClientMock([{ data: null, error: null }])

    await expect(fetchCycle(CYCLE_ID)).resolves.toBeNull()
  })

  it('makes no request for a non-UUID id', async () => {
    const fake = createClientMock([])

    await expect(fetchCycle('cycle-1')).resolves.toBeNull()
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('throws a coded error without the raw Postgres text', async () => {
    createClientMock([
      { data: null, error: { message: 'permission denied for table x' } },
    ])

    const error = await captureError(fetchCycle(CYCLE_ID))
    expect(error).toBeInstanceOf(CyclesApiError)
    expect((error as CyclesApiError).code).toBe('unknown')
    expect((error as CyclesApiError).message).not.toContain('permission')
  })

  it('rejects a row with an unknown status', async () => {
    createClientMock([{ data: { ...detailRow, status: 'open' }, error: null }])

    await expect(fetchCycle(CYCLE_ID)).rejects.toBeInstanceOf(CyclesApiError)
  })

  it('throws when Supabase is not configured', async () => {
    await expect(fetchCycle(CYCLE_ID)).rejects.toBeInstanceOf(CyclesApiError)
  })
})

describe('createCycle', () => {
  it('calls create_cycle with the project, title, and YYYY-MM-DD week', async () => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({
      data: [
        {
          id: CYCLE_ID,
          project_id: PROJECT_ID,
          title: 'Week of Oct 26, 2026',
          week_start: '2026-10-26',
          status: 'collecting',
          created_at: '2026-10-30T12:00:00+00:00',
        },
      ],
      error: null,
    })

    await expect(
      createCycle({
        projectId: PROJECT_ID,
        title: 'Week of Oct 26, 2026',
        weekStart: '2026-10-26',
      }),
    ).resolves.toEqual({
      id: CYCLE_ID,
      projectId: PROJECT_ID,
      title: 'Week of Oct 26, 2026',
      weekStart: '2026-10-26',
      status: 'collecting',
      createdAt: '2026-10-30T12:00:00+00:00',
    })

    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('create_cycle', {
      p_project_id: PROJECT_ID,
      p_title: 'Week of Oct 26, 2026',
      p_week_start: '2026-10-26',
    })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('rejects an empty result', async () => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({ data: [], error: null })

    await expect(
      createCycle({
        projectId: PROJECT_ID,
        title: 'T',
        weekStart: '2026-10-26',
      }),
    ).rejects.toBeInstanceOf(CyclesApiError)
  })
})

describe('closeCycle', () => {
  it('calls close_cycle with the cycle id', async () => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({
      data: [
        {
          id: CYCLE_ID,
          status: 'closed',
          closed_at: '2026-10-31T12:00:00+00:00',
        },
      ],
      error: null,
    })

    await expect(closeCycle(CYCLE_ID)).resolves.toEqual({
      id: CYCLE_ID,
      status: 'closed',
      closedAt: '2026-10-31T12:00:00+00:00',
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('close_cycle', {
      p_cycle_id: CYCLE_ID,
    })
    expect(fake.from).not.toHaveBeenCalled()
  })
})

describe('error mapping', () => {
  const STABLE: Array<[string, string, CyclesErrorCode]> = [
    ['42501', 'not_project_member', 'not_project_member'],
    ['42501', 'not_project_facilitator', 'not_project_facilitator'],
    ['P0001', 'invalid_cycle_title', 'invalid_cycle_title'],
    ['P0001', 'invalid_week_start', 'invalid_week_start'],
    ['P0001', 'cycle_already_open', 'cycle_already_open'],
    ['42501', 'permission denied for function create_cycle', 'unknown'],
    ['PGRST202', 'Could not find the function', 'unknown'],
  ]

  it.each(STABLE)(
    'create_cycle %s %s becomes %s',
    async (pgCode, message, code) => {
      const fake = createClientMock([])
      fake.rpc.mockResolvedValue({
        data: null,
        error: { code: pgCode, message },
      })

      const error = await captureError(
        createCycle({
          projectId: PROJECT_ID,
          title: 'T',
          weekStart: '2026-10-26',
        }),
      )
      expect(error).toBeInstanceOf(CyclesApiError)
      expect((error as CyclesApiError).code).toBe(code)
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    },
  )

  it.each(STABLE)(
    'close_cycle %s %s becomes %s',
    async (pgCode, message, code) => {
      const fake = createClientMock([])
      fake.rpc.mockResolvedValue({
        data: null,
        error: { code: pgCode, message },
      })

      const error = await captureError(closeCycle(CYCLE_ID))
      expect(error).toBeInstanceOf(CyclesApiError)
      expect((error as CyclesApiError).code).toBe(code)
    },
  )

  it('rejects when Supabase is not configured', async () => {
    const error = await captureError(closeCycle(CYCLE_ID))
    expect((error as CyclesApiError).code).toBe('unknown')
  })

  it('maps raw messages to stable codes only on an exact match', () => {
    expect(toCyclesErrorCode('cycle_already_open')).toBe('cycle_already_open')
    expect(toCyclesErrorCode('cycle_already_open: extra')).toBe('unknown')
    expect(toCyclesErrorCode(undefined)).toBe('unknown')
  })

  it('maps each code to a fixed create and close message', () => {
    expect(createCycleErrorMessage('cycle_already_open')).toBe(
      'This project already has an open cycle.',
    )
    expect(createCycleErrorMessage('not_project_facilitator')).toBe(
      'Only the facilitator can start a cycle.',
    )
    for (const code of [
      'not_project_member',
      'invalid_cycle_title',
      'invalid_week_start',
      'unknown',
    ] as const) {
      expect(createCycleErrorMessage(code)).toBe('Could not start the cycle.')
    }
    expect(closeCycleErrorMessage('not_project_facilitator')).toBe(
      'Only the facilitator can close the cycle.',
    )
    for (const code of ['not_project_member', 'unknown'] as const) {
      expect(closeCycleErrorMessage(code)).toBe('Could not close the cycle.')
    }
  })
})

describe('fetchCycleStatus', () => {
  const statusRow = {
    cycle_id: CYCLE_ID,
    status: 'collecting',
    is_revealed: false,
    member_count: 3,
    submitted_member_count: 2,
    my_card_count: 1,
    card_count: null,
  }

  it('calls only get_cycle_status with exactly the cycle id', async () => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({ data: [statusRow], error: null })

    await fetchCycleStatus(CYCLE_ID)

    expect(fake.rpc).toHaveBeenCalledTimes(1)
    const [name, args] = fake.rpc.mock.calls[0] ?? []
    expect(name).toBe('get_cycle_status')
    expect(args).toStrictEqual({ p_cycle_id: CYCLE_ID })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('parses a null card_count before reveal', async () => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({ data: [statusRow], error: null })

    await expect(fetchCycleStatus(CYCLE_ID)).resolves.toStrictEqual({
      cycleId: CYCLE_ID,
      status: 'collecting',
      isRevealed: false,
      memberCount: 3,
      submittedMemberCount: 2,
      myCardCount: 1,
      cardCount: null,
    })
  })

  it('parses a numeric card_count after reveal', async () => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({
      data: [
        { ...statusRow, status: 'reveal', is_revealed: true, card_count: 7 },
      ],
      error: null,
    })

    await expect(fetchCycleStatus(CYCLE_ID)).resolves.toStrictEqual({
      cycleId: CYCLE_ID,
      status: 'reveal',
      isRevealed: true,
      memberCount: 3,
      submittedMemberCount: 2,
      myCardCount: 1,
      cardCount: 7,
    })
  })

  it('drops an extra author_id field', async () => {
    const fake = createClientMock([])
    const authorId = '20000000-0000-4000-8000-000000000009'
    fake.rpc.mockResolvedValue({
      data: [{ ...statusRow, author_id: authorId }],
      error: null,
    })

    const result = await fetchCycleStatus(CYCLE_ID)
    expect(Object.keys(result).sort()).toEqual([
      'cardCount',
      'cycleId',
      'isRevealed',
      'memberCount',
      'myCardCount',
      'status',
      'submittedMemberCount',
    ])
    expect(JSON.stringify(result)).not.toContain(authorId)
  })

  it.each([
    ['no row', []],
    ['a row with a missing count', [{ ...statusRow, member_count: null }]],
    ['a row with an unknown status', [{ ...statusRow, status: 'open' }]],
  ])('treats %s as an unknown failure', async (_label, data) => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({ data, error: null })

    const error = await captureError(fetchCycleStatus(CYCLE_ID))
    expect(error).toBeInstanceOf(CyclesApiError)
    expect((error as CyclesApiError).code).toBe('unknown')
  })

  it.each<[string, string, CyclesErrorCode]>([
    ['42501', 'not_project_member', 'not_project_member'],
    ['42501', 'permission denied for function get_cycle_status', 'unknown'],
    ['XX000', 'something broke near card_authors', 'unknown'],
  ])(
    '%s %s becomes %s without keeping or logging the raw text',
    async (pgCode, message, code) => {
      const fake = createClientMock([])
      fake.rpc.mockResolvedValue({
        data: null,
        error: { code: pgCode, message },
      })

      const error = await captureError(fetchCycleStatus(CYCLE_ID))
      expect(error).toBeInstanceOf(CyclesApiError)
      expect((error as CyclesApiError).code).toBe(code)
      expect((error as CyclesApiError).message).toBe(code)
      if (code === 'unknown') {
        expect(JSON.stringify(error)).not.toContain(message)
      }
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    },
  )

  it('rejects when Supabase is not configured', async () => {
    const error = await captureError(fetchCycleStatus(CYCLE_ID))
    expect((error as CyclesApiError).code).toBe('unknown')
  })
})

describe('startRetrospective', () => {
  const startedRow = {
    id: CYCLE_ID,
    status: 'reveal',
    revealed_at: '2026-11-01T12:00:00+00:00',
  }

  it('calls only start_retrospective with exactly the cycle id', async () => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({ data: [startedRow], error: null })

    await expect(startRetrospective(CYCLE_ID)).resolves.toStrictEqual({
      id: CYCLE_ID,
      status: 'reveal',
      revealedAt: '2026-11-01T12:00:00+00:00',
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    const [name, args] = fake.rpc.mock.calls[0] ?? []
    expect(name).toBe('start_retrospective')
    expect(args).toStrictEqual({ p_cycle_id: CYCLE_ID })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('drops an extra field', async () => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({
      data: [{ ...startedRow, card_count: 7 }],
      error: null,
    })

    const result = await startRetrospective(CYCLE_ID)
    expect(Object.keys(result).sort()).toEqual(['id', 'revealedAt', 'status'])
  })

  it.each([
    ['no row', []],
    ['a row with an unknown status', [{ ...startedRow, status: 'open' }]],
    ['a row without revealed_at', [{ id: CYCLE_ID, status: 'reveal' }]],
  ])('treats %s as an unknown failure', async (_label, data) => {
    const fake = createClientMock([])
    fake.rpc.mockResolvedValue({ data, error: null })

    const error = await captureError(startRetrospective(CYCLE_ID))
    expect(error).toBeInstanceOf(CyclesApiError)
    expect((error as CyclesApiError).code).toBe('unknown')
  })

  it.each<[string, string, CyclesErrorCode]>([
    ['42501', 'not_project_member', 'not_project_member'],
    ['42501', 'not_project_facilitator', 'not_project_facilitator'],
    ['P0001', 'cycle_not_collecting', 'cycle_not_collecting'],
    ['42501', 'permission denied for function start_retrospective', 'unknown'],
    ['P0001', 'cycle_not_collecting: reveal', 'unknown'],
    ['PGRST202', 'Could not find the function', 'unknown'],
  ])(
    '%s %s becomes %s without keeping or logging the raw text',
    async (pgCode, message, code) => {
      const fake = createClientMock([])
      fake.rpc.mockResolvedValue({
        data: null,
        error: { code: pgCode, message },
      })

      const error = await captureError(startRetrospective(CYCLE_ID))
      expect(error).toBeInstanceOf(CyclesApiError)
      expect((error as CyclesApiError).code).toBe(code)
      expect((error as CyclesApiError).message).toBe(code)
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    },
  )

  it('rejects when Supabase is not configured', async () => {
    const error = await captureError(startRetrospective(CYCLE_ID))
    expect((error as CyclesApiError).code).toBe('unknown')
  })

  it('maps each code to a fixed message', () => {
    expect(startRetrospectiveErrorMessage('not_project_facilitator')).toBe(
      'Only the facilitator can start the retrospective.',
    )
    expect(startRetrospectiveErrorMessage('cycle_not_collecting')).toBe(
      'Feedback collection has already ended for this cycle.',
    )
    for (const code of ['not_project_member', 'unknown'] as const) {
      expect(startRetrospectiveErrorMessage(code)).toBe(
        'Could not start the retrospective.',
      )
    }
  })
})
