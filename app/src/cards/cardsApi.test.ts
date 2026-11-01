import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CARDS_ERROR_CODES,
  CardsApiError,
  cardsErrorMessage,
  toCardsErrorCode,
  type CardOperation,
  type CardsErrorCode,
} from './cardsErrors'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

const { fetchMyCards, createCard, updateCard, deleteCard } =
  await vi.importActual<typeof import('./cardsApi')>('./cardsApi')

interface RpcResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const CARD_ID = '40000000-0000-4000-8000-000000000001'

const myRow = {
  id: CARD_ID,
  category: 'start',
  text: 'Ship on Fridays',
  is_anonymous: false,
  created_at: '2026-11-01T10:00:00+00:00',
  updated_at: '2026-11-01T10:00:00+00:00',
}

const savedRow = { ...myRow, cycle_id: CYCLE_ID }

const savedCard = {
  id: CARD_ID,
  cycleId: CYCLE_ID,
  category: 'start',
  text: 'Ship on Fridays',
  isAnonymous: false,
  createdAt: '2026-11-01T10:00:00+00:00',
  updatedAt: '2026-11-01T10:00:00+00:00',
}

function createClientMock(result: RpcResult) {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<RpcResult>
  >(() => Promise.resolve(result))
  const from = vi.fn()
  state.client = { rpc, from }
  return { rpc, from }
}

async function captureError(promise: Promise<unknown>): Promise<CardsApiError> {
  const reason = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )
  expect(reason).toBeInstanceOf(CardsApiError)
  return reason as CardsApiError
}

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('fetchMyCards', () => {
  it('calls get_my_cards with only p_cycle_id and parses each row', async () => {
    const fake = createClientMock({
      data: [
        myRow,
        {
          ...myRow,
          id: '40000000-0000-4000-8000-000000000002',
          category: 'continue',
          is_anonymous: true,
        },
      ],
      error: null,
    })

    await expect(fetchMyCards(CYCLE_ID)).resolves.toEqual([
      {
        id: CARD_ID,
        category: 'start',
        text: 'Ship on Fridays',
        isAnonymous: false,
        createdAt: '2026-11-01T10:00:00+00:00',
        updatedAt: '2026-11-01T10:00:00+00:00',
      },
      {
        id: '40000000-0000-4000-8000-000000000002',
        category: 'continue',
        text: 'Ship on Fridays',
        isAnonymous: true,
        createdAt: '2026-11-01T10:00:00+00:00',
        updatedAt: '2026-11-01T10:00:00+00:00',
      },
    ])
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('get_my_cards', {
      p_cycle_id: CYCLE_ID,
    })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('treats null data as no cards', async () => {
    createClientMock({ data: null, error: null })
    await expect(fetchMyCards(CYCLE_ID)).resolves.toEqual([])
  })

  it('drops an extra field such as author_id', async () => {
    createClientMock({
      data: [{ ...myRow, author_id: 'user-1', email: 'a@example.com' }],
      error: null,
    })

    const [card] = await fetchMyCards(CYCLE_ID)
    expect(Object.keys(card ?? {}).sort()).toEqual([
      'category',
      'createdAt',
      'id',
      'isAnonymous',
      'text',
      'updatedAt',
    ])
    expect(JSON.stringify(card)).not.toContain('user-1')
    expect(JSON.stringify(card)).not.toContain('a@example.com')
  })

  it('rejects a row with an unknown category', async () => {
    createClientMock({ data: [{ ...myRow, category: 'more' }], error: null })
    expect((await captureError(fetchMyCards(CYCLE_ID))).code).toBe('unknown')
  })

  it('maps not_project_member and hides raw text for anything else', async () => {
    createClientMock({ data: null, error: { message: 'not_project_member' } })
    const notMember = await captureError(fetchMyCards(CYCLE_ID))
    expect(notMember.code).toBe('not_project_member')
    expect(notMember.message).toBe('Cycle not found or you do not have access.')

    createClientMock({
      data: null,
      error: { message: 'permission denied for function get_my_cards' },
    })
    const other = await captureError(fetchMyCards(CYCLE_ID))
    expect(other.code).toBe('unknown')
    expect(other.message).toBe('Could not load your feedback.')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('throws when Supabase is not configured', async () => {
    expect((await captureError(fetchMyCards(CYCLE_ID))).code).toBe('unknown')
  })
})

describe('createCard', () => {
  it.each<['start' | 'stop' | 'continue', boolean]>([
    ['start', false],
    ['stop', true],
    ['continue', false],
  ])(
    'calls create_card with exactly four keys for %s (anonymous %s)',
    async (category, isAnonymous) => {
      const fake = createClientMock({
        data: [{ ...savedRow, category, is_anonymous: isAnonymous }],
        error: null,
      })

      await expect(
        createCard({
          cycleId: CYCLE_ID,
          category,
          text: '  Ship on Fridays \n',
          isAnonymous,
        }),
      ).resolves.toEqual({ ...savedCard, category, isAnonymous })

      expect(fake.rpc).toHaveBeenCalledTimes(1)
      const [name, args] = fake.rpc.mock.calls[0] ?? []
      expect(name).toBe('create_card')
      expect(args).toStrictEqual({
        p_cycle_id: CYCLE_ID,
        p_category: category,
        p_text: 'Ship on Fridays',
        p_is_anonymous: isAnonymous,
      })
      expect(fake.from).not.toHaveBeenCalled()
    },
  )

  it('keeps interior line breaks', async () => {
    const fake = createClientMock({ data: [savedRow], error: null })
    await createCard({
      cycleId: CYCLE_ID,
      category: 'start',
      text: '\nline one\nline two\n',
      isAnonymous: false,
    })
    expect(fake.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_text: 'line one\nline two',
    })
  })

  it('drops an extra field such as author_id', async () => {
    createClientMock({
      data: [{ ...savedRow, author_id: 'user-1' }],
      error: null,
    })
    const card = await createCard({
      cycleId: CYCLE_ID,
      category: 'start',
      text: 'x',
      isAnonymous: false,
    })
    expect(card).toStrictEqual(savedCard)
  })

  it('treats an empty result as an unknown failure', async () => {
    createClientMock({ data: [], error: null })
    const error = await captureError(
      createCard({
        cycleId: CYCLE_ID,
        category: 'start',
        text: 'x',
        isAnonymous: false,
      }),
    )
    expect(error.code).toBe('unknown')
  })
})

describe('updateCard', () => {
  it('calls update_card with exactly p_card_id, p_text, and p_is_anonymous', async () => {
    const fake = createClientMock({
      data: [{ ...savedRow, is_anonymous: true }],
      error: null,
    })

    await expect(
      updateCard({ cardId: CARD_ID, text: ' Ship \t', isAnonymous: true }),
    ).resolves.toEqual({ ...savedCard, isAnonymous: true })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    const [name, args] = fake.rpc.mock.calls[0] ?? []
    expect(name).toBe('update_card')
    expect(args).toStrictEqual({
      p_card_id: CARD_ID,
      p_text: 'Ship',
      p_is_anonymous: true,
    })
  })

  it('drops an extra field such as author_id', async () => {
    createClientMock({
      data: [{ ...savedRow, author_id: 'user-1' }],
      error: null,
    })
    await expect(
      updateCard({ cardId: CARD_ID, text: 'x', isAnonymous: false }),
    ).resolves.toStrictEqual(savedCard)
  })
})

describe('deleteCard', () => {
  it('calls delete_card with exactly p_card_id', async () => {
    const fake = createClientMock({ data: null, error: null })

    await expect(deleteCard(CARD_ID)).resolves.toBeUndefined()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    const [name, args] = fake.rpc.mock.calls[0] ?? []
    expect(name).toBe('delete_card')
    expect(args).toStrictEqual({ p_card_id: CARD_ID })
  })
})

describe('card error mapping', () => {
  type Case = readonly [
    rpc: string,
    run: () => Promise<unknown>,
    raw: string,
    code: CardsErrorCode,
    message: string,
  ]

  const add = () =>
    createCard({
      cycleId: CYCLE_ID,
      category: 'start',
      text: 'x',
      isAnonymous: false,
    })
  const save = () =>
    updateCard({ cardId: CARD_ID, text: 'x', isAnonymous: true })
  const remove = () => deleteCard(CARD_ID)

  const NOT_FOUND = 'Cycle not found or you do not have access.'
  const ENDED = 'Feedback collection has ended for this cycle.'
  const GENERIC = 'Could not save the card. Try again.'

  const cases: Case[] = [
    ['create_card', add, 'not_project_member', 'not_project_member', NOT_FOUND],
    ['create_card', add, 'cycle_not_collecting', 'cycle_not_collecting', ENDED],
    [
      'create_card',
      add,
      'invalid_card_category',
      'invalid_card_category',
      GENERIC,
    ],
    ['create_card', add, 'invalid_card_text', 'invalid_card_text', GENERIC],
    [
      'create_card',
      add,
      'invalid_card_anonymity',
      'invalid_card_anonymity',
      GENERIC,
    ],
    ['create_card', add, 'Failed to fetch', 'unknown', GENERIC],
    [
      'update_card',
      save,
      'not_project_member',
      'not_project_member',
      NOT_FOUND,
    ],
    [
      'update_card',
      save,
      'card_not_found',
      'card_not_found',
      'This card no longer exists.',
    ],
    [
      'update_card',
      save,
      'cycle_not_collecting',
      'cycle_not_collecting',
      ENDED,
    ],
    ['update_card', save, 'invalid_card_text', 'invalid_card_text', GENERIC],
    [
      'update_card',
      save,
      'invalid_card_anonymity',
      'invalid_card_anonymity',
      GENERIC,
    ],
    ['update_card', save, 'some_new_code', 'unknown', GENERIC],
    [
      'delete_card',
      remove,
      'not_project_member',
      'not_project_member',
      NOT_FOUND,
    ],
    [
      'delete_card',
      remove,
      'card_not_found',
      'card_not_found',
      'This card was already deleted.',
    ],
    [
      'delete_card',
      remove,
      'cycle_not_collecting',
      'cycle_not_collecting',
      ENDED,
    ],
    [
      'delete_card',
      remove,
      'duplicate key value violates "Ship on Fridays"',
      'unknown',
      GENERIC,
    ],
  ]

  it.each(cases)('%s: %s maps to %s', async (_rpc, run, raw, code, message) => {
    createClientMock({ data: null, error: { message: raw, code: 'P0001' } })

    const error = await captureError(run())
    expect(error.code).toBe(code)
    expect(error.message).toBe(message)
    expect(error.message).not.toContain('Ship on Fridays')
    expect(error.message).not.toContain(CARD_ID)
  })

  it('maps only exact stable codes', () => {
    for (const code of CARDS_ERROR_CODES) {
      expect(toCardsErrorCode(code)).toBe(code)
    }
    expect(toCardsErrorCode('card_not_found: detail')).toBe('unknown')
    expect(toCardsErrorCode(null)).toBe('unknown')
    expect(toCardsErrorCode(undefined)).toBe('unknown')
  })

  it.each<CardOperation>(['add', 'save', 'delete'])(
    'gives an unknown code the generic message for %s',
    (operation) => {
      expect(cardsErrorMessage('unknown', operation)).toBe(GENERIC)
    },
  )

  it('gives a load failure its own message', () => {
    expect(cardsErrorMessage('unknown', 'load')).toBe(
      'Could not load your feedback.',
    )
    expect(cardsErrorMessage('not_project_member', 'load')).toBe(NOT_FOUND)
  })

  it('never logs to the console', async () => {
    createClientMock({ data: null, error: { message: 'card_not_found' } })
    await captureError(save())
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
  })
})
