import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

interface ProfileRow {
  readonly display_name: string | null
}

interface QueryResult {
  readonly data: ProfileRow | null
  readonly error: { readonly message: string } | null
}

function createSupabaseMock() {
  const maybeSingle = vi.fn<() => Promise<QueryResult>>()
  const eq = vi.fn<
    (
      column: string,
      value: string,
    ) => {
      maybeSingle: typeof maybeSingle
    }
  >()
  const select = vi.fn<
    (columns: string) => {
      eq: typeof eq
    }
  >()
  const from = vi.fn<
    (table: string) => {
      select: typeof select
    }
  >()

  eq.mockReturnValue({ maybeSingle })
  select.mockReturnValue({ eq })
  from.mockReturnValue({ select })

  return { from, select, eq, maybeSingle }
}

const { fetchProfileDisplayName } =
  await vi.importActual<typeof import('./profileApi')>('./profileApi')

describe('fetchProfileDisplayName', () => {
  beforeEach(() => {
    state.client = null
  })

  it('selects only display_name for the given user id', async () => {
    const fake = createSupabaseMock()
    state.client = fake
    fake.maybeSingle.mockResolvedValue({
      data: { display_name: 'Dev User' },
      error: null,
    })

    await expect(fetchProfileDisplayName('user-1')).resolves.toBe('Dev User')

    expect(fake.from).toHaveBeenCalledTimes(1)
    expect(fake.from).toHaveBeenCalledWith('profiles')
    expect(fake.select).toHaveBeenCalledTimes(1)
    expect(fake.select).toHaveBeenCalledWith('display_name')
    expect(fake.eq).toHaveBeenCalledTimes(1)
    expect(fake.eq).toHaveBeenCalledWith('id', 'user-1')
    expect(fake.maybeSingle).toHaveBeenCalledTimes(1)
  })

  it.each<[string, ProfileRow | null]>([
    ['a missing row', null],
    ['a null display name', { display_name: null }],
  ])('returns null for %s', async (_label, data) => {
    const fake = createSupabaseMock()
    state.client = fake
    fake.maybeSingle.mockResolvedValue({ data, error: null })

    await expect(fetchProfileDisplayName('user-1')).resolves.toBeNull()
  })

  it('rejects with a generic message and does not expose the raw error', async () => {
    const fake = createSupabaseMock()
    state.client = fake
    fake.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'relation "profiles" denied for user-1' },
    })

    const error: unknown = await fetchProfileDisplayName('user-1').catch(
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Could not load the profile.')
    expect((error as Error).message).not.toContain('denied')
    expect((error as Error).message).not.toContain('profiles')
  })

  it('returns null when Supabase is not configured', async () => {
    state.client = null

    await expect(fetchProfileDisplayName('user-1')).resolves.toBeNull()
  })
})
