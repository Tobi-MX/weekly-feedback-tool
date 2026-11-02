import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from '@supabase/supabase-js'
import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import {
  AiClusteringError,
  isAiFunctionErrorCode,
  KeepAiClustersError,
  toKeepErrorCode,
  type AiClusteringErrorCode,
} from './aiClusteringErrors'

/** The Edge Function's name (#20). */
export const CLUSTER_FUNCTION = 'cluster-feedback'

/** A successful run's counts, exactly as the function returns them. */
export interface AiClusteringResult {
  readonly runId: string
  readonly clusterCount: number
  readonly clusteredCardCount: number
  readonly ungroupedCardCount: number
}

const count = z.number().int().nonnegative()

// Strict: an extra or a missing key, or a negative count, is `unknown`.
const successSchema = z
  .object({
    run_id: z.uuid(),
    cluster_count: count,
    clustered_card_count: count,
    ungrouped_card_count: count,
  })
  .strict()

const errorBodySchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).strict(),
  })
  .strict()

/**
 * The code of a non-2xx answer. The body is read once, as JSON, and only its
 * `code` is kept; the server's `message` is never shown, logged, or kept.
 * Any 401 is `not_authenticated`, whatever the body: the Edge runtime's
 * `verify_jwt` rejects a bad JWT with its own body before the function runs.
 */
async function httpErrorCode(context: unknown): Promise<AiClusteringErrorCode> {
  if (!(context instanceof Response)) {
    return 'unknown'
  }
  if (context.status === 401) {
    return 'not_authenticated'
  }
  let body: unknown
  try {
    body = await context.json()
  } catch {
    return 'unknown'
  }
  const parsed = errorBodySchema.safeParse(body)
  if (!parsed.success) {
    return 'unknown'
  }
  const { code } = parsed.data.error
  return isAiFunctionErrorCode(code) ? code : 'unknown'
}

/**
 * Asks the `cluster-feedback` Edge Function for AI cluster suggestions. The
 * body is exactly `{ cycle_id }`; the Supabase client attaches the user's
 * session and the public anon key. Nothing else (no card, no user id, no key,
 * model, or prompt) leaves the browser. Rejects with an `AiClusteringError`.
 */
export async function requestAiClusters(
  cycleId: string,
): Promise<AiClusteringResult> {
  if (!supabase) {
    throw new AiClusteringError('unknown')
  }
  let result: { data: unknown; error: unknown }
  try {
    result = await supabase.functions.invoke(CLUSTER_FUNCTION, {
      body: { cycle_id: cycleId },
    })
  } catch {
    throw new AiClusteringError('network_error')
  }
  const { data, error } = result
  if (error !== null && error !== undefined) {
    if (error instanceof FunctionsHttpError) {
      throw new AiClusteringError(await httpErrorCode(error.context))
    }
    if (error instanceof FunctionsFetchError) {
      throw new AiClusteringError('network_error')
    }
    if (error instanceof FunctionsRelayError) {
      throw new AiClusteringError('unknown')
    }
    throw new AiClusteringError('unknown')
  }
  const parsed = successSchema.safeParse(data)
  if (!parsed.success) {
    throw new AiClusteringError('unknown')
  }
  return {
    runId: parsed.data.run_id,
    clusterCount: parsed.data.cluster_count,
    clusteredCardCount: parsed.data.clustered_card_count,
    ungroupedCardCount: parsed.data.ungrouped_card_count,
  }
}

/**
 * Keeps every AI suggestion of the cycle (#21): `accept_ai_clusters` turns
 * them into ordinary clusters. Resolves to the number kept. Rejects with a
 * `KeepAiClustersError`.
 */
export async function acceptAiClusters(cycleId: string): Promise<number> {
  if (!supabase) {
    throw new KeepAiClustersError('unknown')
  }
  let result: { data: unknown; error: { message: string } | null }
  try {
    result = await supabase.rpc('accept_ai_clusters', { p_cycle_id: cycleId })
  } catch {
    throw new KeepAiClustersError('unknown')
  }
  if (result.error) {
    throw new KeepAiClustersError(toKeepErrorCode(result.error.message))
  }
  const parsed = count.safeParse(result.data)
  if (!parsed.success) {
    throw new KeepAiClustersError('unknown')
  }
  return parsed.data
}
