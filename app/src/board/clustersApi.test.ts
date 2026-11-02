import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clusterErrorCodeOf,
  clusterErrorMessage,
  moveErrorMessage,
  ClustersApiError,
  type ClusterErrorCode,
} from './clusterErrors'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

const {
  createCluster,
  renameCluster,
  deleteCluster,
  moveCard,
  mergeClusters,
  splitCluster,
} = await vi.importActual<typeof import('./clustersApi')>('./clustersApi')

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const CLUSTER_ID = 'c1000000-0000-4000-8000-000000000001'

const row = { cluster_id: CLUSTER_ID, name: 'Process', source: 'manual' }

function createClientMock(result: DbResult | (() => Promise<DbResult>)) {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<DbResult>
  >(typeof result === 'function' ? result : () => Promise.resolve(result))
  const from = vi.fn()
  state.client = { rpc, from }
  return { rpc, from }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
}

const CARD_ID = 'a0000000-0000-4000-8000-000000000001'

const OTHER_CLUSTER_ID = 'c1000000-0000-4000-8000-000000000002'
const OTHER_CARD_ID = 'a0000000-0000-4000-8000-000000000002'

/** Every call, each with the arguments the tests use. */
const CALLS = [
  ['createCluster', () => createCluster(CYCLE_ID, 'Process')],
  ['renameCluster', () => renameCluster(CLUSTER_ID, 'Process')],
  ['deleteCluster', () => deleteCluster(CLUSTER_ID)],
  ['moveCard', () => moveCard(CARD_ID, CLUSTER_ID, 2)],
  ['mergeClusters', () => mergeClusters(OTHER_CLUSTER_ID, CLUSTER_ID)],
  ['splitCluster', () => splitCluster(CLUSTER_ID, [CARD_ID], 'Tools')],
] as const

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('clustersApi', () => {
  it('createCluster calls create_cluster once with { p_cycle_id, p_name } and parses the row', async () => {
    const fake = createClientMock({ data: [row], error: null })

    await expect(createCluster(CYCLE_ID, '  Process ')).resolves.toStrictEqual({
      clusterId: CLUSTER_ID,
      name: 'Process',
      source: 'manual',
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls[0]).toStrictEqual([
      'create_cluster',
      { p_cycle_id: CYCLE_ID, p_name: '  Process ' },
    ])
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('renameCluster calls rename_cluster once with { p_cluster_id, p_name } and parses the row', async () => {
    const fake = createClientMock({
      data: [{ ...row, name: 'Tooling' }],
      error: null,
    })

    await expect(renameCluster(CLUSTER_ID, 'Tooling')).resolves.toStrictEqual({
      clusterId: CLUSTER_ID,
      name: 'Tooling',
      source: 'manual',
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls[0]).toStrictEqual([
      'rename_cluster',
      { p_cluster_id: CLUSTER_ID, p_name: 'Tooling' },
    ])
  })

  it('deleteCluster calls delete_cluster once with { p_cluster_id }', async () => {
    const fake = createClientMock({ data: null, error: null })

    await expect(deleteCluster(CLUSTER_ID)).resolves.toBeUndefined()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls[0]).toStrictEqual([
      'delete_cluster',
      { p_cluster_id: CLUSTER_ID },
    ])
  })

  it('moveCard calls move_card once with { p_card_id, p_cluster_id, p_position }', async () => {
    const fake = createClientMock({ data: null, error: null })

    await expect(moveCard(CARD_ID, CLUSTER_ID, 0)).resolves.toBeUndefined()
    await expect(moveCard(CARD_ID, null, null)).resolves.toBeUndefined()
    expect(fake.rpc.mock.calls).toStrictEqual([
      [
        'move_card',
        { p_card_id: CARD_ID, p_cluster_id: CLUSTER_ID, p_position: 0 },
      ],
      [
        'move_card',
        { p_card_id: CARD_ID, p_cluster_id: null, p_position: null },
      ],
    ])
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('mergeClusters calls merge_clusters once with { p_source_cluster_id, p_target_cluster_id } and parses the target', async () => {
    const fake = createClientMock({ data: [row], error: null })

    await expect(
      mergeClusters(OTHER_CLUSTER_ID, CLUSTER_ID),
    ).resolves.toStrictEqual({
      clusterId: CLUSTER_ID,
      name: 'Process',
      source: 'manual',
    })
    expect(fake.rpc.mock.calls).toStrictEqual([
      [
        'merge_clusters',
        {
          p_source_cluster_id: OTHER_CLUSTER_ID,
          p_target_cluster_id: CLUSTER_ID,
        },
      ],
    ])
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('splitCluster calls split_cluster once with { p_cluster_id, p_card_ids, p_name } and parses the new cluster', async () => {
    const created = {
      cluster_id: OTHER_CLUSTER_ID,
      name: 'Tools',
      source: 'manual',
    }
    const fake = createClientMock({ data: [created], error: null })

    await expect(
      splitCluster(CLUSTER_ID, [OTHER_CARD_ID, CARD_ID], '  Tools '),
    ).resolves.toStrictEqual({
      clusterId: OTHER_CLUSTER_ID,
      name: 'Tools',
      source: 'manual',
    })
    expect(fake.rpc.mock.calls).toStrictEqual([
      [
        'split_cluster',
        {
          p_cluster_id: CLUSTER_ID,
          p_card_ids: [OTHER_CARD_ID, CARD_ID],
          p_name: '  Tools ',
        },
      ],
    ])
    expect(fake.from).not.toHaveBeenCalled()
  })

  it.each<[string, unknown]>([
    ['no row', []],
    ['two rows', [row, row]],
    ['null data', null],
    ['an extra key', [{ ...row, sort_order: 1 }]],
    ['a timestamp', [{ ...row, created_at: '2026-11-01T09:00:00Z' }]],
    ['a missing source', [{ cluster_id: CLUSTER_ID, name: 'Process' }]],
    ['an unknown source', [{ ...row, source: 'robot' }]],
    ['a non-UUID id', [{ ...row, cluster_id: 'cluster-1' }]],
  ])(
    'a create, rename, merge or split row with %s is unknown',
    async (_label, data) => {
      createClientMock({ data, error: null })

      for (const promise of [
        createCluster(CYCLE_ID, 'Process'),
        renameCluster(CLUSTER_ID, 'Process'),
        mergeClusters(OTHER_CLUSTER_ID, CLUSTER_ID),
        splitCluster(CLUSTER_ID, [CARD_ID], 'Tools'),
      ]) {
        const error = await captureError(promise)
        expect(error).toBeInstanceOf(ClustersApiError)
        expect(clusterErrorCodeOf(error)).toBe('unknown')
      }
    },
  )

  it.each<[string, string, ClusterErrorCode]>([
    ['42501', 'not_project_member', 'not_project_member'],
    ['P0001', 'cluster_not_found', 'cluster_not_found'],
    ['P0001', 'cycle_not_clustering', 'cycle_not_clustering'],
    ['P0001', 'invalid_cluster_name', 'invalid_cluster_name'],
    ['P0001', 'cluster_name_taken', 'cluster_name_taken'],
    ['P0001', 'cluster_limit_reached', 'cluster_limit_reached'],
    ['P0001', 'card_not_found', 'card_not_found'],
    ['P0001', 'invalid_card_position', 'invalid_card_position'],
    ['P0001', 'cannot_merge_into_self', 'cannot_merge_into_self'],
    ['P0001', 'invalid_card_selection', 'invalid_card_selection'],
    ['P0001', 'card_not_in_cluster', 'card_not_in_cluster'],
    ['P0001', 'split_takes_all_cards', 'split_takes_all_cards'],
    ['P0001', 'cluster_not_found: d1000000', 'unknown'],
    ['42501', 'permission denied for function create_cluster', 'unknown'],
    [
      '23505',
      'duplicate key value violates unique constraint "clusters_cycle_id_lower_name_key"',
      'unknown',
    ],
    ['PGRST202', 'Could not find the function', 'unknown'],
  ])(
    'maps %s %s to %s for every call without keeping or logging the raw text',
    async (code, message, expected) => {
      createClientMock({ data: null, error: { code, message } })

      for (const [, call] of CALLS) {
        const error = await captureError(call())
        expect(error).toBeInstanceOf(ClustersApiError)
        expect(clusterErrorCodeOf(error)).toBe(expected)
        expect((error as ClustersApiError).message).toBe(expected)
      }
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    },
  )

  it('maps a thrown network failure and a missing client to unknown', async () => {
    for (const [, call] of CALLS) {
      expect(clusterErrorCodeOf(await captureError(call()))).toBe('unknown')
    }
    createClientMock(() => Promise.reject(new TypeError('fetch failed')))
    for (const [, call] of CALLS) {
      expect(clusterErrorCodeOf(await captureError(call()))).toBe('unknown')
    }
    expect(clusterErrorCodeOf(new Error('network'))).toBe('unknown')
  })

  it('holds the copy for every code in one place', () => {
    expect(clusterErrorMessage('not_project_member', 'save')).toBeNull()
    expect(clusterErrorMessage('cluster_not_found', 'save')).toBe(
      'This cluster no longer exists.',
    )
    expect(clusterErrorMessage('cycle_not_clustering', 'delete')).toBe(
      'Clusters can only be changed during the Cluster stage.',
    )
    expect(clusterErrorMessage('invalid_cluster_name', 'save')).toBe(
      'Enter a cluster name of 1 to 100 characters on one line.',
    )
    expect(clusterErrorMessage('cluster_name_taken', 'save')).toBe(
      'A cluster with this name already exists.',
    )
    expect(clusterErrorMessage('cluster_limit_reached', 'save')).toBe(
      'This cycle already has 50 clusters.',
    )
    expect(clusterErrorMessage('unknown', 'save')).toBe(
      'Could not save the cluster.',
    )
    expect(clusterErrorMessage('unknown', 'delete')).toBe(
      'Could not delete the cluster.',
    )
  })

  it('holds the merge and split copy next to the cluster copy', () => {
    expect(clusterErrorMessage('cannot_merge_into_self', 'merge')).toBe(
      'Choose a different cluster to merge into.',
    )
    expect(clusterErrorMessage('invalid_card_selection', 'split')).toBe(
      'Select the cards to move to the new cluster.',
    )
    expect(clusterErrorMessage('card_not_in_cluster', 'split')).toBe(
      'Some selected cards are no longer in this cluster. Check your selection and try again.',
    )
    expect(clusterErrorMessage('split_takes_all_cards', 'split')).toBe(
      'Leave at least one card in the cluster. To rename it, use Rename.',
    )
    expect(clusterErrorMessage('cluster_not_found', 'merge')).toBe(
      'This cluster no longer exists.',
    )
    expect(clusterErrorMessage('cluster_limit_reached', 'split')).toBe(
      'This cycle already has 50 clusters.',
    )
    expect(clusterErrorMessage('not_project_member', 'split')).toBeNull()
    expect(clusterErrorMessage('unknown', 'merge')).toBe(
      'Could not merge the clusters.',
    )
    expect(clusterErrorMessage('unknown', 'split')).toBe(
      'Could not split the cluster.',
    )
    expect(clusterErrorMessage('unknown', 'save')).toBe(
      'Could not save the cluster.',
    )
  })

  it('holds the move copy next to the cluster copy', () => {
    expect(moveErrorMessage('not_project_member')).toBeNull()
    expect(moveErrorMessage('card_not_found')).toBe(
      'This card no longer exists.',
    )
    expect(moveErrorMessage('cluster_not_found')).toBe(
      'This cluster no longer exists.',
    )
    expect(moveErrorMessage('cycle_not_clustering')).toBe(
      'Cards can only be moved during the Cluster stage.',
    )
    expect(moveErrorMessage('invalid_card_position')).toBe(
      'Could not move the card.',
    )
    expect(moveErrorMessage('unknown')).toBe('Could not move the card.')
  })
})
