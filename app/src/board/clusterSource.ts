/**
 * Where a cluster came from. It lives apart from `boardApi.ts` (which the
 * unit tests replace with a mock) so `clustersApi.ts` can use it too.
 */
export const CLUSTER_SOURCES = ['manual', 'ai'] as const

export type ClusterSource = (typeof CLUSTER_SOURCES)[number]
