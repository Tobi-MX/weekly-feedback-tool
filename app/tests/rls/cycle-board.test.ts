import { beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createProject,
  createRoleCast,
  makeFacilitator,
  projectWithRoles,
  unknownId,
  type ProjectRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

type Category = 'start' | 'stop' | 'continue'

/** An attributed card on the board: exactly six keys. */
interface AttributedBoardCard {
  readonly card_id: string
  readonly category: Category
  readonly text: string
  readonly is_anonymous: false
  readonly is_mine: boolean
  readonly author_display_name: string | null
}

/** An anonymous card on the board: exactly four keys, nothing about authors. */
interface AnonymousBoardCard {
  readonly card_id: string
  readonly category: Category
  readonly text: string
  readonly is_anonymous: true
}

type BoardCard = AttributedBoardCard | AnonymousBoardCard

/** One cluster on the board (#17): exactly four keys. */
interface BoardCluster {
  readonly cluster_id: string
  readonly name: string
  readonly source: 'manual' | 'ai'
  readonly card_ids: readonly string[]
}

/** The `get_cycle_board` response: exactly five keys since Task 17. */
interface CycleBoard {
  readonly cycle_id: string
  readonly status: string
  readonly is_revealed: boolean
  readonly cards: readonly BoardCard[]
  readonly clusters: readonly BoardCluster[]
}

/** One row of `get_cycle_status` (only the columns this file reads). */
interface CycleStatusRow {
  readonly is_revealed: boolean
  readonly my_card_count: number
  readonly card_count: number | null
}

/** One row of `create_card`. */
interface CardRpcRow {
  readonly id: string
  readonly text: string
  readonly is_anonymous: boolean
}

/** One row of `create_cycle`. */
interface CreatedCycleRow {
  readonly id: string
  readonly status: string
}

/** One row of `start_retrospective`. */
interface StartedRow {
  readonly id: string
  readonly status: string
}

/** One row of `close_cycle`. */
interface ClosedCycleRow {
  readonly id: string
  readonly status: string
}

/** Who made a call: a signed-in test user or the signed-out anon client. */
type Caller = TestUser | 'anon'

const BOARD_KEYS = ['cards', 'clusters', 'cycle_id', 'is_revealed', 'status']
const ATTRIBUTED_KEYS = [
  'author_display_name',
  'card_id',
  'category',
  'is_anonymous',
  'is_mine',
  'text',
]
const ANONYMOUS_KEYS = ['card_id', 'category', 'is_anonymous', 'text']
const CATEGORY_ORDER: readonly Category[] = ['start', 'stop', 'continue']

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

/** The board order: category (start, stop, continue), then card id. */
function boardOrder(cards: readonly BoardCard[]): string[] {
  return [...cards]
    .sort((a, b) => {
      const byCategory =
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
      if (byCategory !== 0) {
        return byCategory
      }
      return a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0
    })
    .map((card) => card.card_id)
}

function ids(board: CycleBoard): string[] {
  return board.cards.map((card) => card.card_id)
}

function anonymousCards(board: CycleBoard): AnonymousBoardCard[] {
  return board.cards.filter(
    (card): card is AnonymousBoardCard => card.is_anonymous,
  )
}

function cardById(board: CycleBoard, cardId: string): BoardCard | undefined {
  return board.cards.find((card) => card.card_id === cardId)
}

/** The response with `is_mine` removed from every card. */
function withoutMine(board: CycleBoard): unknown {
  return {
    ...board,
    cards: board.cards.map((card) => {
      if (card.is_anonymous) {
        return card
      }
      return {
        card_id: card.card_id,
        category: card.category,
        text: card.text,
        is_anonymous: card.is_anonymous,
        author_display_name: card.author_display_name,
      }
    }),
  }
}

describe('cycle board', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('board')
  })

  function users(): readonly TestUser[] {
    return [cast.owner, cast.memberA, cast.memberB, cast.nonMember]
  }

  /**
   * The anonymity sweep, run on every call in this file. No response ever
   * carries a test user's id or email. `create_card` and `create_cycle`
   * necessarily return their own row's `created_at`, so only the board and
   * the other calls are also checked for `created_at`, `updated_at`, and
   * `author_id`. No anonymous board card ever carries a user's label.
   */
  function sweep(result: DbResult<unknown>, returnsOwnRow: boolean): void {
    const json = JSON.stringify(result)
    for (const user of users()) {
      expect(json, `response leaks ${user.label} id`).not.toContain(user.id)
      expect(json, `response leaks ${user.label} email`).not.toContain(
        user.email,
      )
    }
    if (!returnsOwnRow) {
      for (const key of ['created_at', 'updated_at', 'author_id']) {
        expect(json, `response contains ${key}`).not.toContain(key)
      }
    }
  }

  function sweepAnonymousCards(board: CycleBoard): void {
    for (const card of anonymousCards(board)) {
      const json = JSON.stringify(card)
      for (const user of users()) {
        expect(json, `anonymous card names ${user.label}`).not.toContain(
          user.label,
        )
      }
    }
  }

  async function observe<T>(
    call: PromiseLike<DbResult<T>>,
    returnsOwnRow = false,
  ): Promise<DbResult<T>> {
    const { data, error } = await call
    const result: DbResult<T> = { data, error }
    sweep(result, returnsOwnRow)
    return result
  }

  async function openCycle(
    owner: TestUser,
    project: ProjectRow,
  ): Promise<string> {
    const result: DbResult<CreatedCycleRow[]> = await observe(
      owner.client.rpc('create_cycle', {
        p_project_id: project.id,
        p_title: 'Board week',
        p_week_start: thisMonday(),
      }),
      true,
    )
    const [row] = expectRows(result, 1)
    return row.id
  }

  async function startRetro(owner: TestUser, cycleId: string): Promise<void> {
    const result: DbResult<StartedRow[]> = await observe(
      owner.client.rpc('start_retrospective', { p_cycle_id: cycleId }),
    )
    const [row] = expectRows(result, 1)
    expect(row.status).toBe('reveal')
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
    category: Category,
    text: string,
    isAnonymous: boolean,
  ): Promise<CardRpcRow> {
    const result: DbResult<CardRpcRow[]> = await observe(
      user.client.rpc('create_card', {
        p_cycle_id: cycleId,
        p_category: category,
        p_text: text,
        p_is_anonymous: isAnonymous,
      }),
      true,
    )
    const [row] = expectRows(result, 1)
    return row
  }

  async function status(
    user: TestUser,
    cycleId: string,
  ): Promise<CycleStatusRow> {
    const result: DbResult<CycleStatusRow[]> = await observe(
      user.client.rpc('get_cycle_status', { p_cycle_id: cycleId }),
    )
    const [row] = expectRows(result, 1)
    return row
  }

  function callBoard(
    caller: Caller,
    cycleId: string,
  ): Promise<DbResult<CycleBoard>> {
    const client = caller === 'anon' ? anonClient() : caller.client
    return observe(client.rpc('get_cycle_board', { p_cycle_id: cycleId }))
  }

  /** The caller's board, checked for its exact key sets and order. */
  async function board(user: TestUser, cycleId: string): Promise<CycleBoard> {
    const result = await callBoard(user, cycleId)
    expect(result.error).toBeNull()
    const data = result.data
    if (data === null) {
      throw new Error('expected a board')
    }
    expect(Object.keys(data).sort()).toEqual(BOARD_KEYS)
    expect(data.cycle_id).toBe(cycleId)
    expect(Array.isArray(data.cards)).toBe(true)
    for (const card of data.cards) {
      expect(Object.keys(card).sort()).toEqual(
        card.is_anonymous ? ANONYMOUS_KEYS : ATTRIBUTED_KEYS,
      )
    }
    expect(ids(data)).toEqual(boardOrder(data.cards))
    sweepAnonymousCards(data)
    return data
  }

  /**
   * The issue's fixture: the owner adds one attributed `continue` card,
   * member A one attributed `start` and one anonymous `stop` card, and
   * member B one anonymous `start` card.
   */
  async function seededCycle(): Promise<{
    project: ProjectRow
    cycleId: string
    ownerCard: CardRpcRow
    aAttributed: CardRpcRow
    aAnonymous: CardRpcRow
    bAnonymous: CardRpcRow
  }> {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const ownerCard = await addCard(
      owner,
      cycleId,
      'continue',
      'Keep the demo slot',
      false,
    )
    const aAttributed = await addCard(
      memberA,
      cycleId,
      'start',
      'Start pairing on reviews',
      false,
    )
    const aAnonymous = await addCard(
      memberA,
      cycleId,
      'stop',
      'Stop late scope changes',
      true,
    )
    const bAnonymous = await addCard(
      memberB,
      cycleId,
      'start',
      'Start writing release notes',
      true,
    )
    return { project, cycleId, ownerCard, aAttributed, aAnonymous, bAnonymous }
  }

  it('before reveal each caller gets only their own cards', async () => {
    const { cycleId, ownerCard, aAttributed, aAnonymous, bAnonymous } =
      await seededCycle()
    const { owner, memberA, memberB } = cast

    const expected = new Map<TestUser, string[]>([
      [owner, [ownerCard.id]],
      [memberA, [aAttributed.id, aAnonymous.id]],
      [memberB, [bAnonymous.id]],
    ])
    for (const [user, mine] of expected) {
      const data = await board(user, cycleId)
      expect(data.status).toBe('collecting')
      expect(data.is_revealed).toBe(false)
      expect([...ids(data)].sort()).toEqual([...mine].sort())
      expect(data.cards).toHaveLength(
        (await status(user, cycleId)).my_card_count,
      )
    }
  })

  it('after the owner starts the retrospective everyone gets all 4 cards in the same order', async () => {
    const { cycleId } = await seededCycle()
    const { owner, memberA, memberB } = cast
    await startRetro(owner, cycleId)

    const boards = [
      await board(owner, cycleId),
      await board(memberA, cycleId),
      await board(memberB, cycleId),
    ]
    const cardCount = (await status(memberB, cycleId)).card_count
    for (const data of boards) {
      expect(data.status).toBe('reveal')
      expect(data.is_revealed).toBe(true)
      expect(data.cards).toHaveLength(4)
      expect(data.cards).toHaveLength(cardCount ?? -1)
      expect(ids(data)).toEqual(ids(boards[0]))
    }

    // Two calls in a row return the same order.
    expect(ids(await board(memberA, cycleId))).toEqual(ids(boards[0]))
  })

  it('the two anonymous cards are deep-equal for every caller and have exactly four keys', async () => {
    const { cycleId, aAnonymous, bAnonymous } = await seededCycle()
    const { owner, memberA, memberB } = cast
    await startRetro(owner, cycleId)

    const ownerAnon = anonymousCards(await board(owner, cycleId))
    const aAnon = anonymousCards(await board(memberA, cycleId))
    const bAnon = anonymousCards(await board(memberB, cycleId))

    expect(ownerAnon.map((card) => card.card_id).sort()).toEqual(
      [aAnonymous.id, bAnonymous.id].sort(),
    )
    expect(aAnon).toEqual(ownerAnon)
    expect(bAnon).toEqual(ownerAnon)
    for (const card of [...ownerAnon, ...aAnon, ...bAnon]) {
      expect(Object.keys(card).sort()).toEqual(ANONYMOUS_KEYS)
    }
  })

  it('attributed cards carry the author name, with is_mine only for the author', async () => {
    const { cycleId, ownerCard, aAttributed } = await seededCycle()
    const { owner, memberA, memberB } = cast
    await startRetro(owner, cycleId)

    for (const user of [owner, memberA, memberB]) {
      const data = await board(user, cycleId)
      expect(cardById(data, aAttributed.id)).toEqual({
        card_id: aAttributed.id,
        category: 'start',
        text: aAttributed.text,
        is_anonymous: false,
        is_mine: user === memberA,
        author_display_name: memberA.label,
      })
      expect(cardById(data, ownerCard.id)).toEqual({
        card_id: ownerCard.id,
        category: 'continue',
        text: ownerCard.text,
        is_anonymous: false,
        is_mine: user === owner,
        author_display_name: owner.label,
      })
    }
  })

  it('responses are deep-equal across callers without is_mine, also after the facilitator role moves', async () => {
    const { project, cycleId } = await seededCycle()
    const { owner, memberA, memberB } = cast
    await startRetro(owner, cycleId)

    async function expectParity(): Promise<void> {
      const ownerBoard = withoutMine(await board(owner, cycleId))
      expect(withoutMine(await board(memberA, cycleId))).toEqual(ownerBoard)
      expect(withoutMine(await board(memberB, cycleId))).toEqual(ownerBoard)
    }

    await expectParity()
    await makeFacilitator(project, owner, memberA)
    await expectParity()
  })

  it('a cycle closed early from collecting shows each caller only their own cards', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    const aCard = await addCard(
      memberA,
      cycleId,
      'stop',
      'Stop the extra standup',
      false,
    )
    await closeCycle(owner, cycleId)

    const aBoard = await board(memberA, cycleId)
    expect(ids(aBoard)).toEqual([aCard.id])
    for (const data of [
      aBoard,
      await board(memberB, cycleId),
      await board(owner, cycleId),
    ]) {
      expect(data.status).toBe('closed')
      expect(data.is_revealed).toBe(false)
    }
    expect((await board(memberB, cycleId)).cards).toEqual([])
    expect((await board(owner, cycleId)).cards).toEqual([])
  })

  it('a revealed cycle with zero cards returns cards: []', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    await startRetro(owner, cycleId)

    for (const user of [owner, memberA]) {
      const data = await board(user, cycleId)
      expect(data.is_revealed).toBe(true)
      expect(data.cards).toEqual([])
    }
  })

  it('a non-member, an unknown id, another project cycle, and anon are refused', async () => {
    const { cycleId } = await seededCycle()
    const { owner, memberA, memberB, nonMember } = cast
    await startRetro(owner, cycleId)

    // A project of the non-member's that member B is not in.
    const otherProject = await createProject(nonMember)
    const otherCycleId = await openCycle(nonMember, otherProject)

    expectPgError(
      await callBoard(nonMember, cycleId),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await callBoard(memberA, unknownId()),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await callBoard(memberB, otherCycleId),
      '42501',
      'not_project_member',
    )
    expectPgError(await callBoard('anon', cycleId), '42501')
  })
})
