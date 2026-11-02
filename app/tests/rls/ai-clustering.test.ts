import { beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createRoleCast,
  projectWithRoles,
  type RoleCast,
  type TestUser,
} from './fixtures'

interface CreatedCycleRow {
  readonly id: string
}

interface StageRow {
  readonly status: string
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
 * The AI clustering RPCs and `ai_runs` are server-only (#20): only the
 * service role, used by the cluster-feedback Edge Function, may call or read
 * them. Every signed-in anon-key client, the facilitator included, is denied.
 */
describe('AI clustering is server-only', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('ai-clustering')
  })

  /** A project with a cycle in the cluster stage and two cards. */
  async function clustering() {
    const roles = await projectWithRoles(cast)
    const cycleResult: DbResult<CreatedCycleRow[]> =
      await roles.owner.client.rpc('create_cycle', {
        p_project_id: roles.project.id,
        p_title: 'AI week',
        p_week_start: thisMonday(),
      })
    const [cycle] = expectRows(cycleResult, 1)
    for (const [user, text] of [
      [roles.memberA, 'AI card one'],
      [roles.memberB, 'AI card two'],
    ] as const) {
      const card: DbResult<unknown[]> = await user.client.rpc('create_card', {
        p_cycle_id: cycle.id,
        p_category: 'start',
        p_text: text,
        p_is_anonymous: true,
      })
      expectRows(card, 1)
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
    return { ...roles, cycleId: cycle.id }
  }

  async function expectDenied(user: TestUser, cycleId: string): Promise<void> {
    const client = user.client
    expectPgError(
      await client.rpc('begin_ai_clustering', {
        p_cycle_id: cycleId,
        p_user_id: user.id,
        p_model: 'claude-opus-5-5',
        p_prompt_version: 'cluster-feedback/v1',
      }),
      '42501',
    )
    expectPgError(
      await client.rpc('replace_ai_clusters', {
        p_run_id: crypto.randomUUID(),
        p_user_id: user.id,
        p_clusters: [],
        p_metrics: {},
      }),
      '42501',
    )
    expectPgError(
      await client.rpc('finish_ai_run', {
        p_run_id: crypto.randomUUID(),
        p_status: 'failed',
        p_error_code: 'internal_error',
        p_metrics: {},
      }),
      '42501',
    )
    expectPgError(await client.from('ai_runs').select(), '42501')
    expectPgError(
      await client
        .from('ai_runs')
        .insert({
          cycle_id: cycleId,
          function_name: 'cluster-feedback',
          model: 'claude-opus-5-5',
          prompt_version: 'cluster-feedback/v1',
          status: 'running',
        })
        .select(),
      '42501',
    )
    expectPgError(
      await client
        .from('ai_runs')
        .update({ status: 'failed', error_code: 'internal_error' })
        .eq('cycle_id', cycleId)
        .select(),
      '42501',
    )
  }

  it('the facilitator cannot call the AI clustering RPCs or touch ai_runs', async () => {
    const { owner, cycleId } = await clustering()
    await expectDenied(owner, cycleId)
  })

  it('a member cannot call the AI clustering RPCs or touch ai_runs', async () => {
    const { memberA, cycleId } = await clustering()
    await expectDenied(memberA, cycleId)
  })

  it('a non-member cannot call the AI clustering RPCs or touch ai_runs', async () => {
    const { nonMember, cycleId } = await clustering()
    await expectDenied(nonMember, cycleId)
  })

  it('an anonymous client cannot call the AI clustering RPCs or read ai_runs', async () => {
    const { cycleId } = await clustering()
    const client = anonClient()
    expectPgError(
      await client.rpc('begin_ai_clustering', {
        p_cycle_id: cycleId,
        p_user_id: crypto.randomUUID(),
        p_model: 'claude-opus-5-5',
        p_prompt_version: 'cluster-feedback/v1',
      }),
      '42501',
    )
    expectPgError(await client.from('ai_runs').select(), '42501')
  })
})
