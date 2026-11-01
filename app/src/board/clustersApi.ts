import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { ClustersApiError, toClusterErrorCode } from './clusterErrors'
import { CLUSTER_SOURCES, type ClusterSource } from './clusterSource'

/** The row `create_cluster` and `rename_cluster` return. */
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
  name: 'create_cluster' | 'rename_cluster' | 'delete_cluster',
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

/** The one row of a create or rename, or `unknown` when it does not parse. */
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
