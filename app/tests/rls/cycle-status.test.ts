import { beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createProject,
  createRoleCast,
  projectWithRoles,
  unknownId,
  type ProjectRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

/** One row of `get_cycle_status`: aggregate counts only. */
interface CycleStatusRow {
  readonly cycle_id: string
  readonly status: string
  readonly is_revealed: boolean
  readonly member_count: number
  readonly submitted_member_count: number
  readonly my_card_count: number
  readonly card_count: number | null
}

/** One row of `create_card`. */
interface CardRpcRow {
  readonly id: string
  readonly cycle_id: string
  readonly category: string
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

const STATUS_COLUMNS = [
  'card_count',
  'cycle_id',
  'is_revealed',
  'member_count',
  'my_card_count',
  'status',
  'submitted_member_count',
]

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

function withoutMine(
  row: CycleStatusRow,
): Omit<CycleStatusRow, 'my_card_count'> {
  return {
    cycle_id: row.cycle_id,
    status: row.status,
    is_revealed: row.is_revealed,
    member_count: row.member_count,
    submitted_member_count: row.submitted_member_count,
    card_count: row.card_count,
  }
}

describe('cycle status', () => {
  let cast: RoleCast
  /** Every card id and text create_card has returned in this file. */
  const cardSecrets: string[] = []

  beforeAll(async () => {
    cast = await createRoleCast('status')
  })

  function users(): readonly TestUser[] {
    return [cast.owner, cast.memberA, cast.memberB, cast.nonMember]
  }

  /**
   * The anonymity sweep. A `create_card` result necessarily carries its own
   * card id, text, and `is_anonymous`, so for it only user ids and emails are
   * checked; every other call is checked for all of them.
   */
  function sweep(result: DbResult<unknown>, isCreateCard: boolean): void {
    const json = JSON.stringify(result)
    for (const user of users()) {
      expect(json, `response leaks ${user.label} id`).not.toContain(user.id)
      expect(json, `response leaks ${user.label} email`).not.toContain(
        user.email,
      )
    }
    if (isCreateCard) {
      return
    }
    for (const secret of cardSecrets) {
      expect(json, 'response leaks a card id or text').not.toContain(secret)
    }
    expect(json.toLowerCase(), 'response mentions anonymous').not.toContain(
      'anonymous',
    )
  }

  async function observe<T>(
    call: PromiseLike<DbResult<T>>,
    isCreateCard = false,
  ): Promise<DbResult<T>> {
    const { data, error } = await call
    const result: DbResult<T> = { data, error }
    sweep(result, isCreateCard)
    return result
  }

  async function openCycle(
    owner: TestUser,
    project: ProjectRow,
  ): Promise<string> {
    const result: DbResult<CreatedCycleRow[]> = await observe(
      owner.client.rpc('create_cycle', {
        p_project_id: project.id,
        p_title: 'Status week',
        p_week_start: thisMonday(),
      }),
    )
    const [row] = expectRows(result, 1)
    return row.id
  }

  async function closeCycle(owner: TestUser, cycleId: string): Promise<void> {
    const result: DbResult<ClosedCycleRow[]> = await observe(
      owner.client.rpc('close_cycle', { p_cycle_id: cycleId }),
    )
    const [row] = expectRows(result, 1)
    expect(row.status).toBe('closed')
  }

  async function addCard(
    user: TestUser,
    cycleId: string,
    text: string,
    isAnonymous: boolean,
  ): Promise<CardRpcRow> {
    const result: DbResult<CardRpcRow[]> = await observe(
      user.client.rpc('create_card', {
        p_cycle_id: cycleId,
        p_category: 'start',
        p_text: text,
        p_is_anonymous: isAnonymous,
      }),
      true,
    )
    const [row] = expectRows(result, 1)
    cardSecrets.push(row.id, row.text)
    return row
  }

  async function deleteCard(user: TestUser, cardId: string): Promise<void> {
    const result: DbResult<unknown> = await observe(
      user.client.rpc('delete_card', { p_card_id: cardId }),
    )
    expect(result.error).toBeNull()
  }

  function callStatus(
    caller: Caller,
    cycleId: string,
  ): Promise<DbResult<CycleStatusRow[]>> {
    const client = caller === 'anon' ? anonClient() : caller.client
    return observe(client.rpc('get_cycle_status', { p_cycle_id: cycleId }))
  }

  /** The caller's single row, with exactly the seven columns. */
  async function status(
    user: TestUser,
    cycleId: string,
  ): Promise<CycleStatusRow> {
    const [row] = expectRows(await callStatus(user, cycleId), 1)
    expect(Object.keys(row).sort()).toEqual(STATUS_COLUMNS)
    return row
  }

  it('the owner, member A, and member B each get 0 of 3 and no total on a new cycle', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)

    for (const user of [owner, memberA, memberB]) {
      expect(await status(user, cycleId)).toEqual({
        cycle_id: cycleId,
        status: 'collecting',
        is_revealed: false,
        member_count: 3,
        submitted_member_count: 0,
        my_card_count: 0,
        card_count: null,
      })
    }
  })

  it('after member A adds three cards and member B one, everyone sees 2 of 3 and no total', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)

    await addCard(memberA, cycleId, 'Status A attributed one', false)
    await addCard(memberA, cycleId, 'Status A attributed two', false)
    await addCard(memberA, cycleId, 'Status A hidden three', true)
    await addCard(memberB, cycleId, 'Status B hidden one', true)

    const expected = {
      cycle_id: cycleId,
      status: 'collecting',
      is_revealed: false,
      member_count: 3,
      submitted_member_count: 2,
      card_count: null,
    }
    const ownerRow = await status(owner, cycleId)
    const aRow = await status(memberA, cycleId)
    const bRow = await status(memberB, cycleId)
    expect(aRow).toEqual({ ...expected, my_card_count: 3 })
    expect(bRow).toEqual({ ...expected, my_card_count: 1 })
    expect(ownerRow).toEqual({ ...expected, my_card_count: 0 })

    // The owner (facilitator) gets the same row as member B.
    expect(withoutMine(ownerRow)).toEqual(withoutMine(bRow))
  })

  it('when member A deletes all three cards, submitted drops to 1 for everyone', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)

    const aCards = [
      await addCard(memberA, cycleId, 'Status A delete one', false),
      await addCard(memberA, cycleId, 'Status A delete two', false),
      await addCard(memberA, cycleId, 'Status A delete three', true),
    ]
    await addCard(memberB, cycleId, 'Status B keeps one', true)
    expect((await status(owner, cycleId)).submitted_member_count).toBe(2)

    for (const card of aCards) {
      await deleteCard(memberA, card.id)
    }

    for (const user of [owner, memberA, memberB]) {
      const row = await status(user, cycleId)
      expect(row.submitted_member_count).toBe(1)
      expect(row.card_count).toBeNull()
    }
    expect((await status(memberA, cycleId)).my_card_count).toBe(0)
    expect((await status(memberB, cycleId)).my_card_count).toBe(1)
  })

  it('after close_cycle from collecting, everyone gets closed, not revealed, and no total', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    await addCard(memberA, cycleId, 'Status A before close', false)
    await addCard(memberB, cycleId, 'Status B before close', true)

    await closeCycle(owner, cycleId)

    for (const user of [owner, memberA, memberB]) {
      const row = await status(user, cycleId)
      expect(row.status).toBe('closed')
      expect(row.is_revealed).toBe(false)
      expect(row.card_count).toBeNull()
      expect(row.member_count).toBe(3)
      expect(row.submitted_member_count).toBe(2)
    }
  })

  it('a non-member, an unknown id, another project cycle, and anon are refused', async () => {
    const { project, owner, memberA, nonMember } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    await addCard(memberA, cycleId, 'Status A refused case', true)

    // A project of the non-member's that member A is not in.
    const otherProject = await createProject(nonMember)
    const otherCycleId = await openCycle(nonMember, otherProject)

    expectPgError(
      await callStatus(nonMember, cycleId),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await callStatus(memberA, unknownId()),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await callStatus(memberA, otherCycleId),
      '42501',
      'not_project_member',
    )
    expectPgError(await callStatus('anon', cycleId), '42501')
  })
})
