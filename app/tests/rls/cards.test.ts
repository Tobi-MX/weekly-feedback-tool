import { beforeAll, describe, expect, it } from 'vitest'
import {
  expectNoRows,
  expectPgError,
  expectRows,
  type DbResult,
} from './assertions'
import {
  anonClient,
  createRoleCast,
  projectWithRoles,
  unknownId,
  type ProjectRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

type Category = 'start' | 'stop' | 'continue'

/** One row of `create_card` and `update_card`. */
interface CardRpcRow {
  readonly id: string
  readonly cycle_id: string
  readonly category: Category
  readonly text: string
  readonly is_anonymous: boolean
  readonly created_at: string
  readonly updated_at: string
}

/** One row of `get_my_cards`. */
interface MyCardRow {
  readonly id: string
  readonly category: Category
  readonly text: string
  readonly is_anonymous: boolean
  readonly created_at: string
  readonly updated_at: string
}

/** One row of `create_cycle`. */
interface CreatedCycleRow {
  readonly id: string
  readonly project_id: string
  readonly status: string
}

/** One row of `close_cycle`. */
interface ClosedCycleRow {
  readonly id: string
  readonly status: string
}

/** Who made a call: a signed-in test user or the signed-out anon client. */
type Caller = TestUser | 'anon'

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

describe('feedback cards', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('cards')
  })

  /**
   * Awaits a call and, for every caller other than member A, checks that the
   * whole `{ data, error }` never mentions member A's user id or email.
   */
  async function observe<T>(
    caller: Caller,
    call: PromiseLike<DbResult<T>>,
  ): Promise<DbResult<T>> {
    const { data, error } = await call
    const result: DbResult<T> = { data, error }
    if (caller === 'anon' || caller.id !== cast.memberA.id) {
      const json = JSON.stringify(result)
      expect(json, 'response leaks member A id').not.toContain(cast.memberA.id)
      expect(json, 'response leaks member A email').not.toContain(
        cast.memberA.email,
      )
    }
    return result
  }

  async function openCycle(
    owner: TestUser,
    project: ProjectRow,
  ): Promise<string> {
    const result: DbResult<CreatedCycleRow[]> = await observe(
      owner,
      owner.client.rpc('create_cycle', {
        p_project_id: project.id,
        p_title: 'Cards week',
        p_week_start: thisMonday(),
      }),
    )
    const [row] = expectRows(result, 1)
    return row.id
  }

  async function closeCycle(owner: TestUser, cycleId: string): Promise<void> {
    const result: DbResult<ClosedCycleRow[]> = await observe(
      owner,
      owner.client.rpc('close_cycle', { p_cycle_id: cycleId }),
    )
    const [row] = expectRows(result, 1)
    expect(row.status).toBe('closed')
  }

  function createCard(
    user: TestUser,
    cycleId: string,
    category: string,
    text: string,
    isAnonymous?: boolean,
  ): Promise<DbResult<CardRpcRow[]>> {
    const args: Record<string, string | boolean> = {
      p_cycle_id: cycleId,
      p_category: category,
      p_text: text,
    }
    if (isAnonymous !== undefined) {
      args.p_is_anonymous = isAnonymous
    }
    return observe(user, user.client.rpc('create_card', args))
  }

  async function newCard(
    user: TestUser,
    cycleId: string,
    category: Category,
    text: string,
    isAnonymous?: boolean,
  ): Promise<CardRpcRow> {
    const [row] = expectRows(
      await createCard(user, cycleId, category, text, isAnonymous),
      1,
    )
    return row
  }

  function updateCard(
    caller: Caller,
    cardId: string,
    text: string,
    isAnonymous: boolean,
  ): Promise<DbResult<CardRpcRow[]>> {
    const client = caller === 'anon' ? anonClient() : caller.client
    return observe(
      caller,
      client.rpc('update_card', {
        p_card_id: cardId,
        p_text: text,
        p_is_anonymous: isAnonymous,
      }),
    )
  }

  function deleteCard(
    caller: Caller,
    cardId: string,
  ): Promise<DbResult<unknown>> {
    const client = caller === 'anon' ? anonClient() : caller.client
    return observe(caller, client.rpc('delete_card', { p_card_id: cardId }))
  }

  function myCards(
    caller: Caller,
    cycleId: string,
  ): Promise<DbResult<MyCardRow[]>> {
    const client = caller === 'anon' ? anonClient() : caller.client
    return observe(caller, client.rpc('get_my_cards', { p_cycle_id: cycleId }))
  }

  async function myCardRows(
    user: TestUser,
    cycleId: string,
  ): Promise<readonly MyCardRow[]> {
    const result = await myCards(user, cycleId)
    return expectRows(result, result.data?.length ?? 0)
  }

  it('member A creates an attributed and an anonymous card and reads both back', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)

    const attributed = await newCard(
      memberA,
      cycleId,
      'start',
      '  Pair on reviews\n',
    )
    expect(attributed.cycle_id).toBe(cycleId)
    expect(attributed.text).toBe('Pair on reviews')
    expect(attributed.is_anonymous).toBe(false)
    expect(Object.keys(attributed).sort()).toEqual([
      'category',
      'created_at',
      'cycle_id',
      'id',
      'is_anonymous',
      'text',
      'updated_at',
    ])

    const anonymous = await newCard(
      memberA,
      cycleId,
      'stop',
      'Late deploys',
      true,
    )
    expect(anonymous.is_anonymous).toBe(true)

    const rows = await myCardRows(memberA, cycleId)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === attributed.id)?.is_anonymous).toBe(
      false,
    )
    expect(rows.find((row) => row.id === anonymous.id)?.is_anonymous).toBe(true)
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'category',
        'created_at',
        'id',
        'is_anonymous',
        'text',
        'updated_at',
      ])
    }
  })

  it('member B, the owner, and member A in another cycle read none of member A cards', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const aAttributed = await newCard(memberA, cycleId, 'start', 'A says hi')
    const aAnonymous = await newCard(memberA, cycleId, 'stop', 'A secret', true)
    const bCard = await newCard(memberB, cycleId, 'continue', 'B says hi')
    const ownerCard = await newCard(owner, cycleId, 'start', 'Owner says hi')
    const aIds = [aAttributed.id, aAnonymous.id]

    const bRows = await myCardRows(memberB, cycleId)
    expect(bRows.map((row) => row.id)).toEqual([bCard.id])

    const ownerRows = await myCardRows(owner, cycleId)
    expect(ownerRows.map((row) => row.id)).toEqual([ownerCard.id])
    expect(ownerRows.some((row) => aIds.includes(row.id))).toBe(false)

    await closeCycle(owner, cycleId)
    const nextCycleId = await openCycle(owner, project)
    expectNoRows(await myCards(memberA, nextCycleId))

    const stillMine = await myCardRows(memberA, cycleId)
    expect(stillMine.map((row) => row.id).sort()).toEqual([...aIds].sort())
  })

  it('member A edits text, switches anonymity, and deletes their own card', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const card = await newCard(memberA, cycleId, 'start', 'First draft')
    const other = await newCard(memberA, cycleId, 'stop', 'To delete')

    const [edited] = expectRows(
      await updateCard(memberA, card.id, ' Second draft\t', true),
      1,
    )
    expect(edited.id).toBe(card.id)
    expect(edited.category).toBe('start')
    expect(edited.text).toBe('Second draft')
    expect(edited.is_anonymous).toBe(true)

    const [readBack] = (await myCardRows(memberA, cycleId)).filter(
      (row) => row.id === card.id,
    )
    expect(readBack.text).toBe('Second draft')
    expect(readBack.is_anonymous).toBe(true)

    const [attributed] = expectRows(
      await updateCard(memberA, card.id, 'Second draft', false),
      1,
    )
    expect(attributed.is_anonymous).toBe(false)

    const deleted = await deleteCard(memberA, other.id)
    expect(deleted.error).toBeNull()
    const rows = await myCardRows(memberA, cycleId)
    expect(rows.map((row) => row.id)).toEqual([card.id])
    expect(rows[0].is_anonymous).toBe(false)
  })

  it('member B and the owner cannot edit or delete member A cards and get the unknown-card result', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const attributed = await newCard(memberA, cycleId, 'start', 'Mine')
    const anonymous = await newCard(memberA, cycleId, 'stop', 'Mine too', true)
    const before = await myCardRows(memberA, cycleId)

    for (const caller of [memberB, owner]) {
      const unknownUpdate = await updateCard(caller, unknownId(), 'x', false)
      const unknownDelete = await deleteCard(caller, unknownId())
      expectPgError(unknownUpdate, 'P0001', 'card_not_found')
      expectPgError(unknownDelete, 'P0001', 'card_not_found')

      for (const card of [attributed, anonymous]) {
        const update = await updateCard(caller, card.id, 'Taken', false)
        expectPgError(update, 'P0001', 'card_not_found')
        expect(update).toEqual(unknownUpdate)

        const removal = await deleteCard(caller, card.id)
        expectPgError(removal, 'P0001', 'card_not_found')
        expect(removal).toEqual(unknownDelete)
      }
    }

    expect(await myCardRows(memberA, cycleId)).toEqual(before)
  })

  it('non-member cannot create, list, edit, or delete cards', async () => {
    const { project, owner, memberA, nonMember } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const card = await newCard(memberA, cycleId, 'start', 'Members only')
    const before = await myCardRows(memberA, cycleId)

    expectPgError(
      await createCard(nonMember, cycleId, 'start', 'Intruder'),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await myCards(nonMember, cycleId),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await updateCard(nonMember, card.id, 'Taken', true),
      'P0001',
      'card_not_found',
    )
    expectPgError(
      await deleteCard(nonMember, card.id),
      'P0001',
      'card_not_found',
    )

    expect(await myCardRows(memberA, cycleId)).toEqual(before)
  })

  it('member A, the owner, and non-member cannot touch cards or card_authors directly', async () => {
    const { project, owner, memberA, nonMember } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const card = await newCard(memberA, cycleId, 'start', 'Direct target')

    for (const user of [memberA, owner, nonMember]) {
      for (const table of ['cards', 'card_authors'] as const) {
        expectPgError(
          await observe(user, user.client.from(table).select()),
          '42501',
        )
        const row: Record<string, string> =
          table === 'cards'
            ? { cycle_id: cycleId, category: 'start', text: 'Direct' }
            : { card_id: card.id, author_id: user.id }
        expectPgError(
          await observe(user, user.client.from(table).insert(row).select()),
          '42501',
        )
        const filterColumn = table === 'cards' ? 'id' : 'card_id'
        const change: Record<string, string> =
          table === 'cards' ? { text: 'Direct edit' } : { author_id: user.id }
        expectPgError(
          await observe(
            user,
            user.client
              .from(table)
              .update(change)
              .eq(filterColumn, card.id)
              .select(),
          ),
          '42501',
        )
        expectPgError(
          await observe(
            user,
            user.client.from(table).delete().eq(filterColumn, card.id).select(),
          ),
          '42501',
        )
      }
    }

    const rows = await myCardRows(memberA, cycleId)
    expect(rows.map((row) => [row.id, row.text])).toEqual([
      [card.id, 'Direct target'],
    ])
  })

  it('anonymous client cannot read card tables or call any card RPC', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const card = await newCard(memberA, cycleId, 'start', 'Signed in only')
    const anon = anonClient()

    expectPgError(await observe('anon', anon.from('cards').select()), '42501')
    expectPgError(
      await observe('anon', anon.from('card_authors').select()),
      '42501',
    )
    expectPgError(
      await observe(
        'anon',
        anon.rpc('create_card', {
          p_cycle_id: cycleId,
          p_category: 'start',
          p_text: 'Anonymous',
        }),
      ),
      '42501',
    )
    expectPgError(await updateCard('anon', card.id, 'Taken', false), '42501')
    expectPgError(await deleteCard('anon', card.id), '42501')
    expectPgError(await myCards('anon', cycleId), '42501')

    const rows = await myCardRows(memberA, cycleId)
    expect(rows.map((row) => row.text)).toEqual(['Signed in only'])
  })

  it('member A cannot create, edit, or delete after close_cycle but still reads their cards', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const card = await newCard(memberA, cycleId, 'start', 'Before close', true)
    const before = await myCardRows(memberA, cycleId)

    await closeCycle(owner, cycleId)

    expectPgError(
      await createCard(memberA, cycleId, 'start', 'After close'),
      'P0001',
      'cycle_not_collecting',
    )
    expectPgError(
      await updateCard(memberA, card.id, 'Edited after close', false),
      'P0001',
      'cycle_not_collecting',
    )
    expectPgError(
      await deleteCard(memberA, card.id),
      'P0001',
      'cycle_not_collecting',
    )

    expect(await myCardRows(memberA, cycleId)).toEqual(before)
  })

  it('member A gets the matching error for invalid input and no row is added', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)

    expectPgError(
      await createCard(memberA, cycleId, 'start', ''),
      'P0001',
      'invalid_card_text',
    )
    expectPgError(
      await createCard(memberA, cycleId, 'start', ' \t\n\r '),
      'P0001',
      'invalid_card_text',
    )
    expectPgError(
      await createCard(memberA, cycleId, 'start', 'x'.repeat(501)),
      'P0001',
      'invalid_card_text',
    )
    expectPgError(
      await createCard(memberA, cycleId, 'Start', 'Wrong case'),
      'P0001',
      'invalid_card_category',
    )

    expectNoRows(await myCards(memberA, cycleId))

    const boundary = await newCard(memberA, cycleId, 'start', 'x'.repeat(500))
    expect(boundary.text).toHaveLength(500)
    expect(await myCardRows(memberA, cycleId)).toHaveLength(1)
  })
})
