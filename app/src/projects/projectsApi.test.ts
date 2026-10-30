import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatedProject, ProjectSummary } from './projectsApi'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

interface QueryResult<T> {
  readonly data: T | null
  readonly error: { readonly message: string } | null
}

const { fetchProjects, fetchProject, createProject } =
  await vi.importActual<typeof import('./projectsApi')>('./projectsApi')

const project: ProjectSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Team',
  created_at: '2026-10-30T12:00:00.000Z',
}

function createListMock() {
  const overrideTypes = vi.fn<() => Promise<QueryResult<ProjectSummary[]>>>()
  const order =
    vi.fn<
      (
        column: string,
        options: { ascending: boolean },
      ) => { overrideTypes: typeof overrideTypes }
    >()
  const eq = vi.fn()
  const select = vi.fn<
    (columns: string) => {
      order: typeof order
      eq: typeof eq
    }
  >()
  const from = vi.fn<(table: string) => { select: typeof select }>()
  const rpc = vi.fn()

  order.mockReturnValue({ overrideTypes })
  select.mockReturnValue({ order, eq })
  from.mockReturnValue({ select })

  return { client: { from, rpc }, from, select, order, eq, overrideTypes, rpc }
}

function createByIdMock() {
  const maybeSingle = vi.fn<() => Promise<QueryResult<ProjectSummary>>>()
  const eq =
    vi.fn<
      (column: string, value: string) => { maybeSingle: typeof maybeSingle }
    >()
  const order = vi.fn()
  const select = vi.fn<
    (columns: string) => {
      eq: typeof eq
      order: typeof order
    }
  >()
  const from = vi.fn<(table: string) => { select: typeof select }>()
  const rpc = vi.fn()

  eq.mockReturnValue({ maybeSingle })
  select.mockReturnValue({ eq, order })
  from.mockReturnValue({ select })

  return { client: { from, rpc }, from, select, eq, order, maybeSingle, rpc }
}

function createInsertMock() {
  const single = vi.fn<() => Promise<QueryResult<CreatedProject>>>()
  const select = vi.fn<(columns: string) => { single: typeof single }>()
  const insert =
    vi.fn<(values: Record<string, unknown>) => { select: typeof select }>()
  const from = vi.fn<(table: string) => { insert: typeof insert }>()
  const rpc = vi.fn()

  select.mockReturnValue({ single })
  insert.mockReturnValue({ select })
  from.mockReturnValue({ insert })

  return { client: { from, rpc }, from, insert, select, single, rpc }
}

beforeEach(() => {
  state.client = null
})

describe('fetchProjects', () => {
  it('selects only id, name, created_at and orders newest first without an owner filter', async () => {
    const fake = createListMock()
    state.client = fake.client
    fake.overrideTypes.mockResolvedValue({ data: [project], error: null })

    await expect(fetchProjects()).resolves.toEqual([project])

    expect(fake.from).toHaveBeenCalledTimes(1)
    expect(fake.from).toHaveBeenCalledWith('projects')
    expect(fake.select).toHaveBeenCalledTimes(1)
    expect(fake.select).toHaveBeenCalledWith('id, name, created_at')
    expect(fake.order).toHaveBeenCalledTimes(1)
    expect(fake.order).toHaveBeenCalledWith('created_at', {
      ascending: false,
    })
    expect(fake.overrideTypes).toHaveBeenCalledTimes(1)
    expect(fake.eq).not.toHaveBeenCalled()
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('returns an empty list for no rows', async () => {
    const fake = createListMock()
    state.client = fake.client
    fake.overrideTypes.mockResolvedValue({ data: null, error: null })

    await expect(fetchProjects()).resolves.toEqual([])
  })

  it('rejects with a generic message and does not expose the raw error', async () => {
    const fake = createListMock()
    state.client = fake.client
    fake.overrideTypes.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for table projects' },
    })

    const error: unknown = await fetchProjects().catch(
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Could not load your projects.')
    expect((error as Error).message).not.toContain('permission denied')
    expect((error as Error).message).not.toContain(
      'permission denied for table projects',
    )
  })

  it('returns an empty list when Supabase is not configured', async () => {
    state.client = null

    await expect(fetchProjects()).resolves.toEqual([])
  })
})

describe('fetchProject', () => {
  it('selects only id, name, created_at and filters by id without an owner filter', async () => {
    const fake = createByIdMock()
    state.client = fake.client
    fake.maybeSingle.mockResolvedValue({ data: project, error: null })

    await expect(fetchProject(project.id)).resolves.toEqual(project)

    expect(fake.from).toHaveBeenCalledTimes(1)
    expect(fake.from).toHaveBeenCalledWith('projects')
    expect(fake.select).toHaveBeenCalledTimes(1)
    expect(fake.select).toHaveBeenCalledWith('id, name, created_at')
    expect(fake.eq).toHaveBeenCalledTimes(1)
    expect(fake.eq).toHaveBeenCalledWith('id', project.id)
    expect(fake.maybeSingle).toHaveBeenCalledTimes(1)
    expect(fake.order).not.toHaveBeenCalled()
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('returns null for an unknown valid id', async () => {
    const fake = createByIdMock()
    state.client = fake.client
    fake.maybeSingle.mockResolvedValue({ data: null, error: null })

    await expect(fetchProject(project.id)).resolves.toBeNull()
    expect(fake.from).toHaveBeenCalledTimes(1)
  })

  it.each(['not-a-uuid', ' project-1 ', ''])(
    'returns null for the non-UUID id %j without querying',
    async (projectId) => {
      const fake = createByIdMock()
      state.client = fake.client

      await expect(fetchProject(projectId)).resolves.toBeNull()
      expect(fake.from).not.toHaveBeenCalled()
    },
  )

  it('rejects with a generic message and does not expose the raw error', async () => {
    const fake = createByIdMock()
    state.client = fake.client
    fake.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'invalid input syntax for type uuid' },
    })

    const error: unknown = await fetchProject(project.id).catch(
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Could not load the project.')
    expect((error as Error).message).not.toContain('uuid')
  })

  it('returns null when Supabase is not configured', async () => {
    state.client = null

    await expect(fetchProject(project.id)).resolves.toBeNull()
  })
})

describe('createProject', () => {
  it('inserts exactly name and owner_id and selects only the new id', async () => {
    const fake = createInsertMock()
    state.client = fake.client
    fake.single.mockResolvedValue({
      data: { id: project.id },
      error: null,
    })

    await expect(
      createProject({ name: 'Team', ownerId: 'user-1' }),
    ).resolves.toEqual({ id: project.id })

    expect(fake.from).toHaveBeenCalledTimes(1)
    expect(fake.from).toHaveBeenCalledWith('projects')
    expect(fake.insert).toHaveBeenCalledTimes(1)
    expect(fake.insert).toHaveBeenCalledWith({
      name: 'Team',
      owner_id: 'user-1',
    })
    expect(Object.keys(fake.insert.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'name',
      'owner_id',
    ])
    expect(fake.select).toHaveBeenCalledTimes(1)
    expect(fake.select).toHaveBeenCalledWith('id')
    expect(fake.single).toHaveBeenCalledTimes(1)
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('rejects with a generic message and does not expose the raw error', async () => {
    const fake = createInsertMock()
    state.client = fake.client
    fake.single.mockResolvedValue({
      data: null,
      error: {
        message:
          'duplicate key value violates unique constraint "projects_pkey"',
      },
    })

    const error: unknown = await createProject({
      name: 'Team',
      ownerId: 'user-1',
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Could not create the project.')
    expect((error as Error).message).not.toContain('duplicate')
    expect((error as Error).message).not.toContain('constraint')
  })

  it('rejects when the insert returns no row', async () => {
    const fake = createInsertMock()
    state.client = fake.client
    fake.single.mockResolvedValue({ data: null, error: null })

    await expect(
      createProject({ name: 'Team', ownerId: 'user-1' }),
    ).rejects.toThrow('Could not create the project.')
  })

  it('rejects when Supabase is not configured', async () => {
    state.client = null

    await expect(
      createProject({ name: 'Team', ownerId: 'user-1' }),
    ).rejects.toThrow('Could not create the project.')
  })
})
