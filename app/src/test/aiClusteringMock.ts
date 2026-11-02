import { vi } from 'vitest'
import type { AiClusteringResult } from '../board/aiClusteringApi'
import {
  AiClusteringError,
  KeepAiClustersError,
} from '../board/aiClusteringErrors'

/**
 * Shared mock for `src/board/aiClusteringApi.ts`. Every test gets it through
 * `setupTests`, so no test calls the `cluster-feedback` Edge Function or
 * `accept_ai_clusters`. By default both fail with `unknown` until a test
 * configures them.
 */
export const aiClusteringMock = {
  requestAiClusters: vi.fn<(cycleId: string) => Promise<AiClusteringResult>>(),
  acceptAiClusters: vi.fn<(cycleId: string) => Promise<number>>(),

  resetAiClusteringMock(): void {
    aiClusteringMock.requestAiClusters
      .mockReset()
      .mockRejectedValue(new AiClusteringError('unknown'))
    aiClusteringMock.acceptAiClusters
      .mockReset()
      .mockRejectedValue(new KeepAiClustersError('unknown'))
  },
}

export function resetAiClusteringMock(): void {
  aiClusteringMock.resetAiClusteringMock()
}
