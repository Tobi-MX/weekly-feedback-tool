/**
 * The stable codes the cluster RPCs raise. Anything else (a network failure,
 * a response that does not match the narrow row schema) is `unknown`.
 * Nothing else from a Postgres error is ever kept, shown, or logged.
 */
export const CLUSTER_ERROR_CODES = [
  'not_project_member',
  'cluster_not_found',
  'cycle_not_clustering',
  'invalid_cluster_name',
  'cluster_name_taken',
  'cluster_limit_reached',
] as const

export type ClusterErrorCode = (typeof CLUSTER_ERROR_CODES)[number] | 'unknown'

/** Which write failed; only the `unknown` copy depends on it. */
export type ClusterOperation = 'save' | 'delete'

/** The board's toast copy for each server error. */
export const CLUSTER_GONE_MESSAGE = 'This cluster no longer exists.'
export const NOT_CLUSTERING_MESSAGE =
  'Clusters can only be changed during the Cluster stage.'
export const INVALID_NAME_MESSAGE =
  'Enter a cluster name of 1 to 100 characters on one line.'
export const NAME_TAKEN_MESSAGE = 'A cluster with this name already exists.'
export const LIMIT_REACHED_MESSAGE = 'This cycle already has 50 clusters.'
export const SAVE_FAILED_MESSAGE = 'Could not save the cluster.'
export const DELETE_FAILED_MESSAGE = 'Could not delete the cluster.'

/** The client's own validation copy, shown inline without a request. */
export const NAME_REQUIRED_MESSAGE = 'Enter a cluster name.'
export const NAME_TOO_LONG_MESSAGE = 'Use 100 characters or fewer.'
export const NAME_UNGROUPED_MESSAGE = 'Choose a name other than Ungrouped.'

/**
 * The toast for a failed write, or null for `not_project_member`, which
 * switches the board to its not-found state instead.
 */
export function clusterErrorMessage(
  code: ClusterErrorCode,
  operation: ClusterOperation,
): string | null {
  switch (code) {
    case 'not_project_member':
      return null
    case 'cluster_not_found':
      return CLUSTER_GONE_MESSAGE
    case 'cycle_not_clustering':
      return NOT_CLUSTERING_MESSAGE
    case 'invalid_cluster_name':
      return INVALID_NAME_MESSAGE
    case 'cluster_name_taken':
      return NAME_TAKEN_MESSAGE
    case 'cluster_limit_reached':
      return LIMIT_REACHED_MESSAGE
    case 'unknown':
      return operation === 'delete'
        ? DELETE_FAILED_MESSAGE
        : SAVE_FAILED_MESSAGE
  }
}

/** An error that carries only a stable code. */
export class ClustersApiError extends Error {
  readonly code: ClusterErrorCode

  constructor(code: ClusterErrorCode) {
    super(code)
    this.name = 'ClustersApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to a stable code, else `unknown`. */
export function toClusterErrorCode(
  message: string | null | undefined,
): ClusterErrorCode {
  return CLUSTER_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

export function clusterErrorCodeOf(error: unknown): ClusterErrorCode {
  return error instanceof ClustersApiError ? error.code : 'unknown'
}
