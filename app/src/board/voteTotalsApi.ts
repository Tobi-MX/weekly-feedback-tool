import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'

/**
 * One row of `get_vote_totals` (#22): a cluster and its total votes. Totals
 * are aggregates only, the same for every caller, and the server returns
 * them ranked (total desc, then the cluster-board order, then id).
 */
export interface VoteTotal {
  readonly clusterId: string
  readonly totalVotes: number
}

/**
 * The stable codes `get_vote_totals` raises. Anything else (a network
 * failure, a reply that does not match the strict row schema) is `unknown`.
 */
export const VOTE_TOTALS_ERROR_CODES = [
  'not_project_member',
  'voting_not_closed',
] as const

export type VoteTotalsErrorCode =
  (typeof VOTE_TOTALS_ERROR_CODES)[number] | 'unknown'

/** An error that carries only a stable code, never the server's text. */
export class VoteTotalsApiError extends Error {
  readonly code: VoteTotalsErrorCode

  constructor(code: VoteTotalsErrorCode) {
    super(code)
    this.name = 'VoteTotalsApiError'
    this.code = code
  }
}

export function voteTotalsErrorCodeOf(error: unknown): VoteTotalsErrorCode {
  return error instanceof VoteTotalsApiError ? error.code : 'unknown'
}

function toVoteTotalsErrorCode(
  message: string | null | undefined,
): VoteTotalsErrorCode {
  return VOTE_TOTALS_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

// Strict: exactly the two columns, and a non-negative integer total.
const totalRowSchema = z
  .object({
    cluster_id: z.string(),
    total_votes: z.number().int().nonnegative(),
  })
  .strict()

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/**
 * The cycle's vote totals in the server's order. Called only while the board
 * is in discuss (#24); the client never re-sorts them.
 */
export async function fetchVoteTotals(
  cycleId: string,
): Promise<readonly VoteTotal[]> {
  if (!supabase) {
    throw new VoteTotalsApiError('unknown')
  }
  let result: DbResult
  try {
    result = await supabase.rpc('get_vote_totals', { p_cycle_id: cycleId })
  } catch {
    throw new VoteTotalsApiError('unknown')
  }
  if (result.error) {
    throw new VoteTotalsApiError(toVoteTotalsErrorCode(result.error.message))
  }
  const parsed = z.array(totalRowSchema).safeParse(result.data)
  if (!parsed.success) {
    throw new VoteTotalsApiError('unknown')
  }
  return parsed.data.map((row) => ({
    clusterId: row.cluster_id,
    totalVotes: row.total_votes,
  }))
}
