import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { ClustersApiError, toClusterErrorCode } from './clusterErrors'
import { CLUSTER_SOURCES, type ClusterSource } from './clusterSource'

/**
 * The row `create_cluster`, `rename_cluster`, `merge_clusters` (the target)
 * and `split_cluster` (the new cluster) return.
 */
export interface SavedCluster {
  readonly clusterId: string
  readonly name: string
  readonly source: ClusterSource
}

// Narrow and strict: exactly the three columns, never a time or an author.
const clusterRowSchema = z
  .object({
    cluster_id: z.uuid(),
    name: z.string(),
    source: z.enum(CLUSTER_SOURCES),
  })
  .strict()

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/** Calls an RPC once and keeps only the stable error code on failure. */
async function callRpc(
  name:
    | 'create_cluster'
    | 'rename_cluster'
    | 'delete_cluster'
    | 'move_card'
    | 'merge_clusters'
    | 'split_cluster',
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!supabase) {
    throw new ClustersApiError('unknown')
  }
  let result: DbResult
  try {
    result = await supabase.rpc(name, args)
  } catch {
    throw new ClustersApiError('unknown')
  }
  if (result.error) {
    throw new ClustersApiError(toClusterErrorCode(result.error.message))
  }
  return result.data
}

/** The one row of a write, or `unknown` when it does not parse. */
function parseClusterRow(data: unknown): SavedCluster {
  const parsed = z.array(clusterRowSchema).length(1).safeParse(data)
  if (!parsed.success) {
    throw new ClustersApiError('unknown')
  }
  const [row] = parsed.data
  return { clusterId: row.cluster_id, name: row.name, source: row.source }
}

/**
 * Creates a manual cluster at the end of the cycle's clusters. The server
 * trims the name and applies every name rule.
 */
export async function createCluster(
  cycleId: string,
  name: string,
): Promise<SavedCluster> {
  return parseClusterRow(
    await callRpc('create_cluster', { p_cycle_id: cycleId, p_name: name }),
  )
}

/** Renames a cluster; a renamed AI cluster becomes manual. */
export async function renameCluster(
  clusterId: string,
  name: string,
): Promise<SavedCluster> {
  return parseClusterRow(
    await callRpc('rename_cluster', { p_cluster_id: clusterId, p_name: name }),
  )
}

/** Deletes a cluster; its cards become ungrouped. */
export async function deleteCluster(clusterId: string): Promise<void> {
  await callRpc('delete_cluster', { p_cluster_id: clusterId })
}

/**
 * Moves a card (#18). A null cluster is Ungrouped, and then the position must
 * be null. The position is the card's zero-based index in the target after
 * the move, counted among the target's other cards; null means the end, and
 * the server clamps a larger value to the end.
 */
export async function moveCard(
  cardId: string,
  clusterId: string | null,
  position: number | null,
): Promise<void> {
  await callRpc('move_card', {
    p_card_id: cardId,
    p_cluster_id: clusterId,
    p_position: position,
  })
}

/**
 * Merges the source cluster into the target (#19): the source's cards go to
 * the end of the target and the source is deleted. Returns the target.
 */
export async function mergeClusters(
  sourceClusterId: string,
  targetClusterId: string,
): Promise<SavedCluster> {
  return parseClusterRow(
    await callRpc('merge_clusters', {
      p_source_cluster_id: sourceClusterId,
      p_target_cluster_id: targetClusterId,
    }),
  )
}

/**
 * Splits the given cards of a cluster into a new manual cluster with the
 * given name (#19). The server keeps the cards' order in the cluster, trims
 * the name and applies every name rule. Returns the new cluster.
 */
export async function splitCluster(
  clusterId: string,
  cardIds: readonly string[],
  name: string,
): Promise<SavedCluster> {
  return parseClusterRow(
    await callRpc('split_cluster', {
      p_cluster_id: clusterId,
      p_card_ids: cardIds,
      p_name: name,
    }),
  )
}
