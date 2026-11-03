import type { RealtimeChannel } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createRoleCast,
  projectWithRoles,
  type ProjectWithRoles,
  type RoleCast,
  type TestUser,
} from './fixtures'

interface CreatedCycleRow {
  readonly id: string
}

interface StageRow {
  readonly status: string
}

interface ClusterRow {
  readonly cluster_id: string
}

interface StatusRow {
  readonly cluster_id: string
  readonly discussion_status: string
}

interface AddRow {
  readonly note_id: string
  readonly cluster_id: string | null
}

interface DiscussionNoteRow {
  readonly note_id: string
  readonly cluster_id: string | null
  readonly text: string
  readonly author_name: string | null
  readonly is_mine: boolean
  readonly created_at: string
  readonly edited_at: string | null
}

interface Discussion {
  readonly cycle_id: string
  readonly statuses: readonly StatusRow[]
  readonly notes: readonly DiscussionNoteRow[]
}

interface EventRow {
  readonly id: string
  readonly type: string
  readonly from_status: string
  readonly to_status: string
  readonly actor_id: string | null
  readonly payload: Record<string, unknown>
}

/** One cycle_events INSERT as Realtime delivers it. */
interface CycleEventPayload {
  readonly new: EventRow
}

/** System messages Realtime sends on a channel. */
interface SystemMessage {
  readonly extension?: string
  readonly status?: string
}

/** How long the channel may take to become ready. */
const READY_TIMEOUT_MS = 30_000
/** How long the expected events may take to arrive. */
const EVENT_TIMEOUT_MS = 10_000
/** How long the channel is watched after the last expected event. */
const QUIET_MS = 3_000
const STAGE_RACE_ROUNDS = 10

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Settles like `promise`, or rejects with `message` after `ms`. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function addNote(
  user: TestUser,
  cycleId: string,
  clusterId: string | null,
  text: string,
): PromiseLike<DbResult<AddRow[]>> {
  return user.client.rpc('add_note', {
    p_cycle_id: cycleId,
    p_cluster_id: clusterId,
    p_text: text,
  })
}

async function added(
  user: TestUser,
  cycleId: string,
  clusterId: string | null,
  text: string,
): Promise<string> {
  const [row] = expectRows(await addNote(user, cycleId, clusterId, text), 1)
  expect(row.cluster_id).toBe(clusterId)
  return row.note_id
}

function setStatus(
  user: TestUser,
  clusterId: string,
  status: string,
): PromiseLike<DbResult<StatusRow[]>> {
  return user.client.rpc('set_discussion_status', {
    p_cluster_id: clusterId,
    p_status: status,
  })
}

function readDiscussion(
  user: TestUser,
  cycleId: string,
): PromiseLike<DbResult<Discussion>> {
  return user.client.rpc('get_cycle_discussion', { p_cycle_id: cycleId })
}

async function discussion(
  user: TestUser,
  cycleId: string,
): Promise<Discussion> {
  const result = await readDiscussion(user, cycleId)
  expect(result.error).toBeNull()
  if (result.data === null) {
    throw new Error('no discussion')
  }
  return result.data
}

/**
 * Discussion statuses and notes (#25) through real anon-key clients: the
 * RPCs are the only path, the table is closed to every client, and every
 * write broadcasts one id-free event.
 */
describe('discussion', () => {
  let roleCast: RoleCast

  beforeAll(async () => {
    roleCast = await createRoleCast('discussion')
  })

  /**
   * A new cycle of the project taken to discuss by the owner (the
   * facilitator) through the RPCs: clusters X and Y, vote, close_voting.
   */
  async function discussCycle(roles: ProjectWithRoles): Promise<{
    cycleId: string
    x: string
    y: string
  }> {
    const { owner } = roles
    const created: DbResult<CreatedCycleRow[]> = await owner.client.rpc(
      'create_cycle',
      {
        p_project_id: roles.project.id,
        p_title: 'Discussion week',
        p_week_start: thisMonday(),
      },
    )
    const [cycle] = expectRows(created, 1)
    const started: DbResult<StageRow[]> = await owner.client.rpc(
      'start_retrospective',
      { p_cycle_id: cycle.id },
    )
    expect(expectRows(started, 1)[0].status).toBe('reveal')
    const toCluster: DbResult<StageRow[]> = await owner.client.rpc(
      'advance_stage',
      { p_cycle_id: cycle.id, p_from_status: 'reveal' },
    )
    expect(expectRows(toCluster, 1)[0].status).toBe('cluster')
    const clusterIds: string[] = []
    for (const name of ['X', 'Y']) {
      const made: DbResult<ClusterRow[]> = await owner.client.rpc(
        'create_cluster',
        { p_cycle_id: cycle.id, p_name: name },
      )
      clusterIds.push(expectRows(made, 1)[0].cluster_id)
    }
    const toVote: DbResult<StageRow[]> = await owner.client.rpc(
      'advance_stage',
      { p_cycle_id: cycle.id, p_from_status: 'cluster' },
    )
    expect(expectRows(toVote, 1)[0].status).toBe('vote')
    const closed: DbResult<StageRow[]> = await owner.client.rpc(
      'close_voting',
      { p_cycle_id: cycle.id },
    )
    expect(expectRows(closed, 1)[0].status).toBe('discuss')
    return { cycleId: cycle.id, x: clusterIds[0], y: clusterIds[1] }
  }

  async function endCycle(owner: TestUser, cycleId: string): Promise<void> {
    const closed = await owner.client.rpc('close_cycle', {
      p_cycle_id: cycleId,
    })
    expect(closed.error).toBeNull()
  }

  it('B adds notes and A sets a status through the RPCs; every direct access to notes and discussion_status is refused', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d, nonMember: c } = roles
    const { cycleId, x } = await discussCycle(roles)

    const topicNote = await added(b, cycleId, x, 'Pair on reviews')
    await added(b, cycleId, null, 'Thanks all')
    expect(expectRows(await setStatus(a, x, 'discussed'), 1)).toEqual([
      { cluster_id: x, discussion_status: 'discussed' },
    ])

    for (const client of [
      anonClient(),
      a.client,
      b.client,
      d.client,
      c.client,
    ]) {
      expectPgError(await client.from('notes').select(), '42501')
      expectPgError(
        await client
          .from('notes')
          .insert({ cycle_id: cycleId, author_id: b.id, text: 'direct' })
          .select(),
        '42501',
      )
      expectPgError(
        await client
          .from('notes')
          .update({ text: 'taken over' })
          .eq('id', topicNote)
          .select(),
        '42501',
      )
      expectPgError(
        await client.from('notes').delete().eq('id', topicNote).select(),
        '42501',
      )
      expectPgError(
        await client
          .from('clusters')
          .update({ discussion_status: 'skipped' })
          .eq('id', x)
          .select(),
        '42501',
      )
    }

    // Nothing changed.
    const after = await discussion(a, cycleId)
    expect(after.notes.map((note) => note.text)).toEqual([
      'Pair on reviews',
      'Thanks all',
    ])
    expect(after.statuses.find((s) => s.cluster_id === x)).toEqual({
      cluster_id: x,
      discussion_status: 'discussed',
    })
    await endCycle(a, cycleId)
  })

  it("D reads B's notes with B's name and is_mine false; C is refused; B cannot set a status", async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d, nonMember: c } = roles
    const { cycleId, x } = await discussCycle(roles)
    const noteId = await added(b, cycleId, x, 'From B')

    const seenByD = await discussion(d, cycleId)
    expect(Object.keys(seenByD).sort()).toEqual([
      'cycle_id',
      'notes',
      'statuses',
    ])
    expect(seenByD.notes).toHaveLength(1)
    expect(seenByD.notes[0]).toMatchObject({
      note_id: noteId,
      cluster_id: x,
      text: 'From B',
      author_name: b.label,
      is_mine: false,
      edited_at: null,
    })
    const seenByB = await discussion(b, cycleId)
    expect(seenByB.notes[0].is_mine).toBe(true)
    for (const user of [a, b, d, c]) {
      expect(JSON.stringify(seenByD)).not.toContain(user.id)
    }

    expectPgError(
      await readDiscussion(c, cycleId),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await addNote(c, cycleId, null, 'intruder'),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await setStatus(b, x, 'skipped'),
      '42501',
      'not_project_facilitator',
    )
    await endCycle(a, cycleId)
  })

  it('a Realtime subscriber gets one INSERT per note write and per real status change, and none for a no-op', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles
    const { cycleId, x } = await discussCycle(roles)

    const received: CycleEventPayload[] = []
    let channel: RealtimeChannel | undefined
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          let subscribed = false
          let listening = false
          const settle = () => {
            if (subscribed && listening) {
              resolve()
            }
          }
          channel = d.client
            .channel(`rls-discussion-${cycleId}`)
            .on('system', {}, (message: SystemMessage) => {
              if (message.extension !== 'postgres_changes') {
                return
              }
              if (message.status === 'ok') {
                listening = true
                settle()
              } else {
                reject(new Error(`could not listen: ${message.status}`))
              }
            })
            .on(
              'postgres_changes',
              {
                event: 'INSERT',
                schema: 'public',
                table: 'cycle_events',
                filter: `cycle_id=eq.${cycleId}`,
              },
              (payload: CycleEventPayload) => {
                received.push(payload)
              },
            )
            .subscribe((status) => {
              if (status === 'SUBSCRIBED') {
                subscribed = true
                settle()
              }
            })
        }),
        READY_TIMEOUT_MS,
        'the channel was not ready within 30 s',
      )

      const existing = await d.client
        .from('cycle_events')
        .select('id')
        .eq('cycle_id', cycleId)
      expect(existing.error).toBeNull()
      const setupIds = new Set((existing.data ?? []).map((row) => row.id))
      const fresh = () =>
        received.filter((payload) => !setupIds.has(payload.new.id))

      // add, edit, a no-op edit, delete; a status change and a no-op one.
      const noteId = await added(b, cycleId, x, 'First')
      expectRows(
        await b.client.rpc('update_note', {
          p_note_id: noteId,
          p_text: 'Second',
        }),
        1,
      )
      expectRows(
        await b.client.rpc('update_note', {
          p_note_id: noteId,
          p_text: '  Second  ',
        }),
        1,
      )
      expectRows(await b.client.rpc('delete_note', { p_note_id: noteId }), 1)
      expectRows(await setStatus(a, x, 'deferred'), 1)
      expectRows(await setStatus(a, x, 'deferred'), 1)

      await withTimeout(
        (async () => {
          while (fresh().length < 4) {
            await delay(100)
          }
        })(),
        EVENT_TIMEOUT_MS,
        'the events did not arrive within 10 s',
      )
      await delay(QUIET_MS)

      const events = fresh().map((payload) => payload.new)
      expect(events.map((event) => event.type).sort()).toEqual([
        'clusters_changed',
        'notes_changed',
        'notes_changed',
        'notes_changed',
      ])
      for (const event of events) {
        expect(event).toMatchObject({
          from_status: 'discuss',
          to_status: 'discuss',
          actor_id: null,
          payload: {},
        })
      }
    } finally {
      if (channel) {
        await d.client.removeChannel(channel)
      }
    }
    await endCycle(a, cycleId)
  }, 60_000)

  it('limit race: with 498 notes, 5 parallel adds give exactly 2 successes and 3 note_limit_reached', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles
    const { cycleId } = await discussCycle(roles)

    // Test files never use the service role (_docs/testing.md), so the 498
    // notes go in through add_note, in batches.
    for (let start = 0; start < 498; start += 50) {
      const batch = Array.from(
        { length: Math.min(50, 498 - start) },
        (_unused, index) =>
          addNote(
            index % 2 === 0 ? b : d,
            cycleId,
            null,
            `Filler ${start + index}`,
          ),
      )
      for (const result of await Promise.all(batch)) {
        expectRows(result, 1)
      }
    }

    const results = await Promise.all([
      addNote(b, cycleId, null, 'race 1'),
      addNote(d, cycleId, null, 'race 2'),
      addNote(b, cycleId, null, 'race 3'),
      addNote(d, cycleId, null, 'race 4'),
      addNote(b, cycleId, null, 'race 5'),
    ])
    const succeeded = results.filter((result) => result.error === null)
    const refused = results.filter((result) => result.error !== null)
    expect(succeeded).toHaveLength(2)
    expect(refused).toHaveLength(3)
    for (const result of refused) {
      expectPgError(result, 'P0001', 'note_limit_reached')
    }
    expect((await discussion(a, cycleId)).notes).toHaveLength(500)
    await endCycle(a, cycleId)
  }, 120_000)

  it('stage race: add_note racing close_cycle either succeeds or gets cycle_not_discussing, never another error', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b } = roles

    for (let round = 0; round < STAGE_RACE_ROUNDS; round += 1) {
      const { cycleId } = await discussCycle(roles)
      const [add, close] = await Promise.all([
        addNote(b, cycleId, null, `Round ${round}`),
        a.client.rpc('close_cycle', { p_cycle_id: cycleId }),
      ])
      expect(close.error).toBeNull()
      let successes = 0
      if (add.error !== null) {
        expectPgError(add, 'P0001', 'cycle_not_discussing')
      } else {
        expectRows(add, 1)
        successes = 1
      }
      expect((await discussion(b, cycleId)).notes).toHaveLength(successes)
    }
  }, 120_000)
})
