import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { CARD_CATEGORIES, type CardCategory } from '@/cards/cardCategories'
import { CYCLE_STATUSES, type CycleStatus } from '@/cycles/cycleStatus'
import { isProjectId } from '@/projects/projectId'
import { BoardApiError, toBoardErrorCode } from './boardErrors'
import { CLUSTER_SOURCES, type ClusterSource } from './clusterSource'

/**
 * An anonymous card: no author key of any kind, and the same for every
 * caller, its author included.
 */
export interface AnonymousBoardCard {
  readonly cardId: string
  readonly category: CardCategory
  readonly text: string
  readonly isAnonymous: true
}

/** An attributed card. `authorDisplayName` is null for a deleted author. */
export interface AttributedBoardCard {
  readonly cardId: string
  readonly category: CardCategory
  readonly text: string
  readonly isAnonymous: false
  readonly isMine: boolean
  readonly authorDisplayName: string | null
}

export type BoardCard = AnonymousBoardCard | AttributedBoardCard

/**
 * One cluster. `cardIds` keeps the server's order; every id is a card of the
 * same response, and no card is in two clusters.
 */
export interface BoardCluster {
  readonly clusterId: string
  readonly name: string
  readonly source: ClusterSource
  readonly cardIds: readonly string[]
}

/**
 * One of the caller's own votes, per cluster: `voteCount` is 1 to 3. Vote
 * totals are never on the board (#22); they come only from `get_vote_totals`
 * once voting has closed.
 */
export interface MyVote {
  readonly clusterId: string
  readonly voteCount: number
}

/** Each member has exactly this many votes per cycle (#22). */
export const VOTES_PER_MEMBER = 3

/**
 * One `get_cycle_board` response. `cards` and `clusters` keep the server's
 * order. A card in no cluster's `cardIds` is ungrouped. `myVotes` (in
 * cluster order) and `votesRemaining` describe only the caller's own votes;
 * together they always add up to `VOTES_PER_MEMBER`.
 */
export interface CycleBoard {
  readonly cycleId: string
  readonly status: CycleStatus
  readonly isRevealed: boolean
  readonly cards: readonly BoardCard[]
  readonly clusters: readonly BoardCluster[]
  readonly myVotes: readonly MyVote[]
  readonly votesRemaining: number
}

// Strict: an extra or a missing key fails to parse, so a response that
// carries more than the contract (for example an author name on an anonymous
// card, or a timestamp) is shown as a load error rather than rendered. #18
// and #22 add their keys here in the PR that extends the RPC.
const anonymousCardSchema = z
  .object({
    card_id: z.string(),
    category: z.enum(CARD_CATEGORIES),
    text: z.string(),
    is_anonymous: z.literal(true),
  })
  .strict()

const attributedCardSchema = z
  .object({
    card_id: z.string(),
    category: z.enum(CARD_CATEGORIES),
    text: z.string(),
    is_anonymous: z.literal(false),
    is_mine: z.boolean(),
    author_display_name: z.string().nullable(),
  })
  .strict()

// #17: exactly four keys, and no time, order, or author of any kind.
const clusterSchema = z
  .object({
    cluster_id: z.uuid(),
    name: z.string(),
    source: z.enum(CLUSTER_SOURCES),
    card_ids: z.array(z.uuid()),
  })
  .strict()

// #22: the caller's own votes on one cluster, exactly two keys.
const myVoteSchema = z
  .object({
    cluster_id: z.uuid(),
    vote_count: z.number().int().min(1).max(VOTES_PER_MEMBER),
  })
  .strict()

const cycleBoardSchema = z
  .object({
    cycle_id: z.string(),
    status: z.enum(CYCLE_STATUSES),
    is_revealed: z.boolean(),
    cards: z.array(
      z.discriminatedUnion('is_anonymous', [
        anonymousCardSchema,
        attributedCardSchema,
      ]),
    ),
    clusters: z.array(clusterSchema),
    my_votes: z.array(myVoteSchema),
    votes_remaining: z.number().int().min(0).max(VOTES_PER_MEMBER),
  })
  .strict()
  .refine((board) => {
    // Every clustered id is a card of this response, and no card is in two
    // clusters. Anything else is a contract break, shown as a load error.
    const cardIds = new Set(board.cards.map((card) => card.card_id))
    const seen = new Set<string>()
    for (const cluster of board.clusters) {
      for (const cardId of cluster.card_ids) {
        if (!cardIds.has(cardId) || seen.has(cardId)) {
          return false
        }
        seen.add(cardId)
      }
    }
    return true
  })
  .refine((board) => {
    // Every own vote is on a cluster of this response, no cluster appears
    // twice, and the votes plus the remaining count are exactly the budget.
    const clusterIds = new Set(board.clusters.map((c) => c.cluster_id))
    const seen = new Set<string>()
    let used = 0
    for (const vote of board.my_votes) {
      if (!clusterIds.has(vote.cluster_id) || seen.has(vote.cluster_id)) {
        return false
      }
      seen.add(vote.cluster_id)
      used += vote.vote_count
    }
    return used + board.votes_remaining === VOTES_PER_MEMBER
  })

type CardRow = z.infer<typeof cycleBoardSchema>['cards'][number]

function toCard(row: CardRow): BoardCard {
  if (row.is_anonymous) {
    return {
      cardId: row.card_id,
      category: row.category,
      text: row.text,
      isAnonymous: true,
    }
  }
  return {
    cardId: row.card_id,
    category: row.category,
    text: row.text,
    isAnonymous: false,
    isMine: row.is_mine,
    authorDisplayName: row.author_display_name,
  }
}

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/**
 * The board for one cycle, through `get_cycle_board` only. A non-UUID id
 * resolves to `null` (not found) without a request. The response must match
 * the strict schema; the card order is the server's and is never changed.
 */
export async function fetchCycleBoard(
  cycleId: string,
): Promise<CycleBoard | null> {
  if (!supabase) {
    throw new BoardApiError('unknown')
  }
  if (!isProjectId(cycleId)) {
    return null
  }

  const { data, error }: DbResult = await supabase.rpc('get_cycle_board', {
    p_cycle_id: cycleId,
  })
  if (error) {
    throw new BoardApiError(toBoardErrorCode(error.message))
  }

  const parsed = cycleBoardSchema.safeParse(data)
  if (!parsed.success) {
    throw new BoardApiError('unknown')
  }
  const row = parsed.data
  return {
    cycleId: row.cycle_id,
    status: row.status,
    isRevealed: row.is_revealed,
    cards: row.cards.map(toCard),
    clusters: row.clusters.map((cluster) => ({
      clusterId: cluster.cluster_id,
      name: cluster.name,
      source: cluster.source,
      cardIds: cluster.card_ids,
    })),
    myVotes: row.my_votes.map((vote) => ({
      clusterId: vote.cluster_id,
      voteCount: vote.vote_count,
    })),
    votesRemaining: row.votes_remaining,
  }
}
