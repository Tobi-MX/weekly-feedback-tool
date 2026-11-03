import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { VOTES_PER_MEMBER } from './boardApi'
import { toVoteErrorCode, VotesApiError } from './voteErrors'

/**
 * The one row `cast_vote` and `remove_vote` return (#22): the caller's own
 * votes on the cluster and the caller's votes left, after the write. Never a
 * total or anyone else's votes.
 */
export interface VoteResult {
  readonly clusterId: string
  readonly voteCount: number
  readonly votesRemaining: number
}

// Narrow and strict: exactly the three columns.
const voteRowSchema = z
  .object({
    cluster_id: z.string(),
    vote_count: z.number().int(),
    votes_remaining: z.number().int(),
  })
  .strict()

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/** Calls a vote RPC once and keeps only the stable error code on failure. */
async function callVoteRpc(
  name: 'cast_vote' | 'remove_vote',
  cycleId: string,
  clusterId: string,
): Promise<unknown> {
  if (!supabase) {
    throw new VotesApiError('unknown')
  }
  let result: DbResult
  try {
    result = await supabase.rpc(name, {
      p_cycle_id: cycleId,
      p_cluster_id: clusterId,
    })
  } catch {
    throw new VotesApiError('unknown')
  }
  if (result.error) {
    throw new VotesApiError(toVoteErrorCode(result.error.message))
  }
  return result.data
}

interface Range {
  readonly min: number
  readonly max: number
}

/**
 * The one row of a vote write, or `unknown` when it does not parse, names
 * another cluster, or holds a count the write cannot produce.
 */
function parseVoteRow(
  data: unknown,
  clusterId: string,
  voteCount: Range,
  votesRemaining: Range,
): VoteResult {
  const parsed = z.array(voteRowSchema).length(1).safeParse(data)
  if (!parsed.success) {
    throw new VotesApiError('unknown')
  }
  const [row] = parsed.data
  if (
    row.cluster_id !== clusterId ||
    row.vote_count < voteCount.min ||
    row.vote_count > voteCount.max ||
    row.votes_remaining < votesRemaining.min ||
    row.votes_remaining > votesRemaining.max
  ) {
    throw new VotesApiError('unknown')
  }
  return {
    clusterId: row.cluster_id,
    voteCount: row.vote_count,
    votesRemaining: row.votes_remaining,
  }
}

/**
 * Adds one of the caller's votes to a cluster. After it the caller has 1 to
 * 3 votes on it and 0 to 2 left.
 */
export async function castVote(
  cycleId: string,
  clusterId: string,
): Promise<VoteResult> {
  return parseVoteRow(
    await callVoteRpc('cast_vote', cycleId, clusterId),
    clusterId,
    { min: 1, max: VOTES_PER_MEMBER },
    { min: 0, max: VOTES_PER_MEMBER - 1 },
  )
}

/**
 * Removes one of the caller's votes from a cluster. After it the caller has
 * 0 to 2 votes on it and 1 to 3 left.
 */
export async function removeVote(
  cycleId: string,
  clusterId: string,
): Promise<VoteResult> {
  return parseVoteRow(
    await callVoteRpc('remove_vote', cycleId, clusterId),
    clusterId,
    { min: 0, max: VOTES_PER_MEMBER - 1 },
    { min: 1, max: VOTES_PER_MEMBER },
  )
}
