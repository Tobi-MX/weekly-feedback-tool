import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  createRoleCast,
  makeFacilitator,
  projectWithRoles,
  type ProjectWithRoles,
  type RoleCast,
  type TestUser,
} from './fixtures'

interface CreatedCycleRow {
  readonly id: string
}

interface CardRpcRow {
  readonly id: string
}

interface StageRow {
  readonly status: string
}

interface ClusterRow {
  readonly cluster_id: string
}

interface BoardCluster {
  readonly cluster_id: string
  readonly name: string
  readonly source: 'manual' | 'ai'
  readonly card_ids: readonly string[]
}

interface CycleBoard {
  readonly cycle_id: string
  readonly status: string
  readonly is_revealed: boolean
  readonly cards: readonly { readonly card_id: string }[]
  readonly clusters: readonly BoardCluster[]
}

interface BeginResult {
  readonly run_id: string
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

/**
 * A service-role client, used only to seed AI clusters the way the
 * cluster-feedback Edge Function writes them (#20's RPCs are service-role
 * only). It is never used for an allow or deny assertion.
 */
function seedClient(): SupabaseClient {
  const env = inject('rlsEnv')
  return createClient(env.url, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
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

/**
 * Keeping AI suggestions (#21): `accept_ai_clusters` turns every AI cluster
 * of the cycle manual, for the current facilitator only.
 */
describe('accept_ai_clusters', () => {
  let cast: RoleCast
  let seed: SupabaseClient

  beforeAll(async () => {
    cast = await createRoleCast('accept-ai')
    seed = seedClient()
  })

  /**
   * A cycle in cluster with four cards, one manual cluster made by the
   * owner (the facilitator), and two AI clusters written through #20's
   * begin_ai_clustering + replace_ai_clusters.
   */
  async function withSuggestions(): Promise<
    ProjectWithRoles & { cycleId: string }
  > {
    const roles = await projectWithRoles(cast)
    const cycleResult: DbResult<CreatedCycleRow[]> =
      await roles.owner.client.rpc('create_cycle', {
        p_project_id: roles.project.id,
        p_title: 'Keep week',
        p_week_start: thisMonday(),
      })
    const [cycle] = expectRows(cycleResult, 1)
    const cards: string[] = []
    for (const [user, category, anonymous] of [
      [roles.memberA, 'start', true],
      [roles.memberB, 'start', false],
      [roles.owner, 'stop', true],
      [roles.memberA, 'stop', false],
      [roles.memberB, 'continue', true],
    ] as const) {
      const card: DbResult<CardRpcRow[]> = await user.client.rpc(
        'create_card',
        {
          p_cycle_id: cycle.id,
          p_category: category,
          p_text: `Keep card ${cards.length + 1}`,
          p_is_anonymous: anonymous,
        },
      )
      cards.push(expectRows(card, 1)[0].id)
    }
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

    const manual: DbResult<ClusterRow[]> = await roles.owner.client.rpc(
      'create_cluster',
      { p_cycle_id: cycle.id, p_name: 'Mine' },
    )
    const [mine] = expectRows(manual, 1)
    const moved: DbResult<unknown> = await roles.owner.client.rpc('move_card', {
      p_card_id: cards[4],
      p_cluster_id: mine.cluster_id,
      p_position: null,
    })
    expect(moved.error).toBeNull()

    const begun: DbResult<BeginResult> = await seed.rpc('begin_ai_clustering', {
      p_cycle_id: cycle.id,
      p_user_id: roles.owner.id,
      p_model: 'claude-opus-5-5',
      p_prompt_version: 'cluster-feedback/v1',
    })
    expect(begun.error).toBeNull()
    const runId = begun.data?.run_id
    expect(typeof runId).toBe('string')
    const replaced: DbResult<unknown> = await seed.rpc('replace_ai_clusters', {
      p_run_id: runId,
      p_user_id: roles.owner.id,
      p_clusters: [
        { name: 'Starts', category: 'start', card_ids: [cards[0], cards[1]] },
        { name: 'Stops', category: 'stop', card_ids: [cards[2], cards[3]] },
      ],
      p_metrics: {},
    })
    expect(replaced.error).toBeNull()
    return { ...roles, cycleId: cycle.id }
  }

  it('the facilitator keeps the suggestions, and the board shows them as manual', async () => {
    const { owner, memberA, cycleId } = await withSuggestions()
    const before = await board(memberA, cycleId)
    expect(before.clusters.map((cluster) => cluster.source)).toEqual([
      'manual',
      'ai',
      'ai',
    ])

    const kept: DbResult<number> = await owner.client.rpc(
      'accept_ai_clusters',
      { p_cycle_id: cycleId },
    )
    expect(kept.error).toBeNull()
    expect(kept.data).toBe(2)

    const after = await board(memberA, cycleId)
    expect(after.clusters).toEqual(
      before.clusters.map((cluster) => ({ ...cluster, source: 'manual' })),
    )

    const again: DbResult<number> = await owner.client.rpc(
      'accept_ai_clusters',
      { p_cycle_id: cycleId },
    )
    expect(again.error).toBeNull()
    expect(again.data).toBe(0)
    expect(await board(memberA, cycleId)).toEqual(after)
  })

  it('a member, the owner who is no longer facilitator, and a non-member are refused and change nothing', async () => {
    const roles = await withSuggestions()
    const { owner, memberA, memberB, nonMember, project, cycleId } = roles
    const before = await board(memberA, cycleId)

    expectPgError(
      await memberA.client.rpc('accept_ai_clusters', { p_cycle_id: cycleId }),
      '42501',
      'not_project_facilitator',
    )
    expect(await board(memberA, cycleId)).toEqual(before)

    await makeFacilitator(project, owner, memberB)
    expectPgError(
      await owner.client.rpc('accept_ai_clusters', { p_cycle_id: cycleId }),
      '42501',
      'not_project_facilitator',
    )
    expect(await board(memberA, cycleId)).toEqual(before)

    expectPgError(
      await nonMember.client.rpc('accept_ai_clusters', {
        p_cycle_id: cycleId,
      }),
      '42501',
      'not_project_member',
    )
    expect(await board(memberA, cycleId)).toEqual(before)
    expect(before.clusters.filter((c) => c.source === 'ai')).toHaveLength(2)
  })
})
