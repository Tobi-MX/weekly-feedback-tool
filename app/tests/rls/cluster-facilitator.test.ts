import { beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  createRoleCast,
  makeFacilitator,
  projectWithRoles,
  unknownId,
  type RoleCast,
  type TestUser,
} from './fixtures'

/** One row of `create_cluster`, `rename_cluster`, `merge_clusters`, `split_cluster`. */
interface ClusterRow {
  readonly cluster_id: string
  readonly name: string
  readonly source: 'manual' | 'ai'
}

/** One cluster on the board. */
interface BoardCluster {
  readonly cluster_id: string
  readonly name: string
  readonly source: 'manual' | 'ai'
  readonly card_ids: readonly string[]
}

/** The `get_cycle_board` response, kept whole for before/after comparisons. */
interface CycleBoard {
  readonly cycle_id: string
  readonly status: string
  readonly is_revealed: boolean
  readonly cards: readonly { readonly card_id: string }[]
  readonly clusters: readonly BoardCluster[]
}

interface CardRpcRow {
  readonly id: string
}

interface CreatedCycleRow {
  readonly id: string
}

interface StageRow {
  readonly status: string
}

/** The six cluster writes, by name. */
type Op = 'create' | 'rename' | 'delete' | 'move' | 'merge' | 'split'

const OPS: readonly Op[] = [
  'create',
  'rename',
  'delete',
  'move',
  'merge',
  'split',
]

/** Valid ids for one call of each write on a clustering cycle. */
interface Targets {
  readonly cycleId: string
  /** A cluster with two cards: renamed, split, and merged into. */
  readonly full: string
  /** A cluster with one card: deleted and merged away. */
  readonly other: string
  /** An ungrouped card: moved into `full`. */
  readonly loose: string
  /** A card of `full`: split out. */
  readonly splitCard: string
}

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

async function board(user: TestUser, cycleId: string): Promise<CycleBoard> {
  const result: DbResult<CycleBoard> = await user.client.rpc(
    'get_cycle_board',
    { p_cycle_id: cycleId },
  )
  expect(result.error).toBeNull()
  if (result.data === null) {
    throw new Error('expected a board')
  }
  return result.data
}

/** One cluster write as the user. */
async function write(
  user: TestUser,
  op: Op,
  targets: Targets,
  name = `${op} by ${user.label}`,
): Promise<DbResult<unknown>> {
  const client = user.client
  switch (op) {
    case 'create':
      return client.rpc('create_cluster', {
        p_cycle_id: targets.cycleId,
        p_name: name,
      })
    case 'rename':
      return client.rpc('rename_cluster', {
        p_cluster_id: targets.full,
        p_name: name,
      })
    case 'delete':
      return client.rpc('delete_cluster', { p_cluster_id: targets.other })
    case 'move':
      return client.rpc('move_card', {
        p_card_id: targets.loose,
        p_cluster_id: targets.full,
        p_position: null,
      })
    case 'merge':
      return client.rpc('merge_clusters', {
        p_source_cluster_id: targets.other,
        p_target_cluster_id: targets.full,
      })
    case 'split':
      return client.rpc('split_cluster', {
        p_cluster_id: targets.full,
        p_card_ids: [targets.splitCard],
        p_name: name,
      })
  }
}

describe('cluster editing is facilitator-only', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('cluster-facilitator')
  })

  async function addCard(
    user: TestUser,
    cycleId: string,
    text: string,
    isAnonymous: boolean,
  ): Promise<string> {
    const result: DbResult<CardRpcRow[]> = await user.client.rpc(
      'create_card',
      {
        p_cycle_id: cycleId,
        p_category: 'start',
        p_text: text,
        p_is_anonymous: isAnonymous,
      },
    )
    return expectRows(result, 1)[0].id
  }

  async function createCluster(
    user: TestUser,
    cycleId: string,
    name: string,
  ): Promise<string> {
    const result: DbResult<ClusterRow[]> = await user.client.rpc(
      'create_cluster',
      { p_cycle_id: cycleId, p_name: name },
    )
    return expectRows(result, 1)[0].cluster_id
  }

  async function moveCard(
    user: TestUser,
    cardId: string,
    clusterId: string | null,
  ): Promise<void> {
    const result: DbResult<unknown> = await user.client.rpc('move_card', {
      p_card_id: cardId,
      p_cluster_id: clusterId,
      p_position: null,
    })
    expect(result.error).toBeNull()
  }

  /**
   * A project with a cycle in cluster: attributed and anonymous cards from
   * member A and member B, and two clusters made by the owner (the
   * facilitator by default).
   */
  async function clustering() {
    const roles = await projectWithRoles(cast)
    const cycleResult: DbResult<CreatedCycleRow[]> =
      await roles.owner.client.rpc('create_cycle', {
        p_project_id: roles.project.id,
        p_title: 'Facilitator week',
        p_week_start: thisMonday(),
      })
    const [cycle] = expectRows(cycleResult, 1)
    const cards = [
      await addCard(roles.memberA, cycle.id, 'A attributed', false),
      await addCard(roles.memberA, cycle.id, 'A hidden', true),
      await addCard(roles.memberB, cycle.id, 'B hidden', true),
      await addCard(roles.memberB, cycle.id, 'B attributed', false),
    ]
    const started: DbResult<StageRow[]> = await roles.owner.client.rpc(
      'start_retrospective',
      { p_cycle_id: cycle.id },
    )
    expect(expectRows(started, 1)[0].status).toBe('reveal')
    const advanced: DbResult<StageRow[]> = await roles.owner.client.rpc(
      'advance_stage',
      { p_cycle_id: cycle.id, p_from_status: 'reveal' },
    )
    expect(expectRows(advanced, 1)[0].status).toBe('cluster')
    return { ...roles, cycleId: cycle.id, cards }
  }

  /** Fresh fixture clusters, made by the given facilitator. */
  async function targetsBy(
    facilitator: TestUser,
    cycleId: string,
    cards: readonly string[],
    tag: string,
  ): Promise<Targets> {
    const full = await createCluster(facilitator, cycleId, `${tag} full`)
    const other = await createCluster(facilitator, cycleId, `${tag} other`)
    await moveCard(facilitator, cards[0], full)
    await moveCard(facilitator, cards[1], full)
    await moveCard(facilitator, cards[2], other)
    await moveCard(facilitator, cards[3], null)
    return {
      cycleId,
      full,
      other,
      loose: cards[3],
      splitCard: cards[1],
    }
  }

  /** Every one of the six is refused with not_project_facilitator. */
  async function expectRefusedAll(
    user: TestUser,
    targets: Targets,
  ): Promise<void> {
    for (const op of OPS) {
      expectPgError(
        await write(user, op, targets),
        '42501',
        'not_project_facilitator',
      )
    }
  }

  /** Every one of the six succeeds, each on fresh clusters. */
  async function expectAllowedAll(
    user: TestUser,
    cycleId: string,
    cards: readonly string[],
  ): Promise<void> {
    for (const op of OPS) {
      const targets = await targetsBy(
        user,
        cycleId,
        cards,
        `${op} ${user.label}`,
      )
      const result = await write(user, op, targets)
      expect(result.error, `${user.label} ${op}`).toBeNull()
    }
  }

  it('the owner, as facilitator, runs all six; members A and B are refused and change nothing', async () => {
    const { owner, memberA, memberB, cycleId, cards } = await clustering()

    await expectAllowedAll(owner, cycleId, cards)

    const targets = await targetsBy(owner, cycleId, cards, 'fixture')
    const before = await board(memberA, cycleId)
    await expectRefusedAll(memberA, targets)
    await expectRefusedAll(memberB, targets)
    expect(await board(memberA, cycleId)).toEqual(before)
  })

  it('after makeFacilitator, member A runs all six and the owner and member B are refused; then member A loses the role', async () => {
    const { project, owner, memberA, memberB, cycleId, cards } =
      await clustering()

    await makeFacilitator(project, owner, memberA)
    await expectAllowedAll(memberA, cycleId, cards)

    const targets = await targetsBy(memberA, cycleId, cards, 'fixture')
    const before = await board(memberB, cycleId)
    await expectRefusedAll(owner, targets)
    await expectRefusedAll(memberB, targets)
    expect(await board(memberB, cycleId)).toEqual(before)

    await makeFacilitator(project, owner, memberB)
    await expectRefusedAll(memberA, targets)
    expect(await board(memberB, cycleId)).toEqual(before)
    await expectAllowedAll(memberB, cycleId, cards)
  })

  it('a transfer racing an edit: the edit succeeds or gets not_project_facilitator, never a deadlock, and the board matches', async () => {
    const { project, owner, memberA, memberB, cycleId, cards } =
      await clustering()
    const cluster = await createCluster(owner, cycleId, 'Raced')
    const rotation: readonly TestUser[] = [memberA, memberB, owner]
    let facilitator: TestUser = owner
    let expectedName = 'Raced'

    for (let round = 0; round < 10; round += 1) {
      const next = rotation[round % rotation.length]
      const target =
        next.id === facilitator.id ? rotation[(round + 1) % 3] : next
      const name = `Round ${round}`
      const [transfer, edit] = await Promise.all([
        owner.client.rpc('transfer_facilitator', {
          p_project_id: project.id,
          p_user_id: target.id,
        }),
        facilitator.client.rpc('rename_cluster', {
          p_cluster_id: cluster,
          p_name: name,
        }),
      ])
      expect(transfer.error, `round ${round} transfer`).toBeNull()
      if (edit.error === null) {
        expectedName = name
      } else {
        expectPgError(edit, '42501', 'not_project_facilitator')
      }
      const current = await board(memberA, cycleId)
      expect(
        current.clusters.find((entry) => entry.cluster_id === cluster)?.name,
        `round ${round} board`,
      ).toBe(expectedName)
      facilitator = target
    }

    // The final facilitator still edits; the cards were never touched.
    const final = await facilitator.client.rpc('rename_cluster', {
      p_cluster_id: cluster,
      p_name: 'After the race',
    })
    expect(final.error).toBeNull()
    const after = await board(memberB, cycleId)
    expect(after.clusters).toEqual([
      {
        cluster_id: cluster,
        name: 'After the race',
        source: 'manual',
        card_ids: [],
      },
    ])
    expect(after.cards.map((card) => card.card_id).sort()).toEqual(
      [...cards].sort(),
    )
  }, 60_000)

  it('the non-member gets the same responses as before for all six, for real and random ids', async () => {
    const { owner, memberA, nonMember, cycleId, cards } = await clustering()
    const targets = await targetsBy(owner, cycleId, cards, 'fixture')
    const before = await board(memberA, cycleId)
    const expected: Record<Op, [string, string]> = {
      create: ['42501', 'not_project_member'],
      rename: ['P0001', 'cluster_not_found'],
      delete: ['P0001', 'cluster_not_found'],
      move: ['P0001', 'card_not_found'],
      merge: ['P0001', 'cluster_not_found'],
      split: ['P0001', 'cluster_not_found'],
    }
    const random: Targets = {
      cycleId: unknownId(),
      full: unknownId(),
      other: unknownId(),
      loose: unknownId(),
      splitCard: targets.splitCard,
    }

    for (const op of OPS) {
      const [code, message] = expected[op]
      const real = await write(nonMember, op, targets, 'Sneaky')
      expectPgError(real, code, message)
      expect(await write(nonMember, op, random, 'Sneaky')).toEqual(real)
    }
    expect(await board(memberA, cycleId)).toEqual(before)
  })
})
