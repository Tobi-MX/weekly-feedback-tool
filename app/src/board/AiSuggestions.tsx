import { type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  AI_CLUSTER_LIMIT_MESSAGE,
  AI_CLUSTERING_ERRORS,
} from './aiClusteringErrors'
import type { CycleBoard } from './boardApi'
import type { AiAlert } from './useAiClustering'

/** Wraps long unbroken text at 375 px; no `break-words`, which would win. */
const wrapAnywhere = 'min-w-0 [overflow-wrap:anywhere]'

export const AI_PANEL_TEXT =
  'Ask AI to group the cards that are not in clusters you made or changed. Suggestions are marked "AI suggestion" and you can change them like any cluster.'
export const AI_PROGRESS_TEXT =
  'This can take up to 2 minutes. Cluster changes are paused until the suggestions arrive.'
export const AI_GENERATING_ANNOUNCEMENT = 'Generating suggestions.'
export const AI_REMOTE_ANNOUNCEMENT = 'New AI suggestions are on the board.'
export const AI_NOTHING_TO_KEEP_ANNOUNCEMENT =
  'There were no AI suggestions left to keep.'

/** #20's limits, as the panel checks them before offering a run. */
export const AI_MIN_CARDS = 2
export const AI_MAX_CARDS = 300
export const AI_MAX_MANUAL_CLUSTERS = 50

/** The board's counts the panel works from. */
export interface AiBoardCounts {
  readonly cardCount: number
  /** Cards that are ungrouped or in an AI cluster. */
  readonly available: number
  readonly aiClusters: number
  readonly manualClusters: number
}

export function aiBoardCounts(board: CycleBoard): AiBoardCounts {
  const inManual = new Set(
    board.clusters
      .filter((cluster) => cluster.source === 'manual')
      .flatMap((cluster) => cluster.cardIds),
  )
  const aiClusters = board.clusters.filter(
    (cluster) => cluster.source === 'ai',
  ).length
  return {
    cardCount: board.cards.length,
    available: board.cards.filter((card) => !inManual.has(card.cardId)).length,
    aiClusters,
    manualClusters: board.clusters.length - aiClusters,
  }
}

function clusters(count: number): string {
  return count === 1 ? '1 cluster' : `${count} clusters`
}

/**
 * Why the panel offers no run, or null when it does. `limitReached` is this
 * tab's `ai_run_limit_reached`, whose copy the panel's alert shows.
 */
export function aiBlockedReason(
  counts: AiBoardCounts,
  limitReached: boolean,
): string | null {
  if (counts.cardCount === 0) {
    return 'There are no cards to group.'
  }
  if (counts.available < AI_MIN_CARDS) {
    return 'AI suggestions need at least 2 cards that are not in clusters you made or changed.'
  }
  if (counts.available > AI_MAX_CARDS) {
    return `AI suggestions work with up to 300 cards that are not in clusters you made or changed. This board has ${counts.available}.`
  }
  if (counts.manualClusters >= AI_MAX_MANUAL_CLUSTERS) {
    return AI_CLUSTER_LIMIT_MESSAGE
  }
  if (limitReached) {
    return AI_CLUSTERING_ERRORS.ai_run_limit_reached.copy
  }
  return null
}

export function suggestQuestion(counts: AiBoardCounts): string {
  const available = counts.available
  const those =
    available === 1
      ? 'the 1 card that is not'
      : `the ${available} cards that are not`
  return `Suggest clusters for ${those} in clusters you made or changed? The suggestions appear as clusters marked "AI suggestion". Your clusters and their cards stay as they are.`
}

export function regenerateQuestion(counts: AiBoardCounts): string {
  const available = counts.available
  const those =
    available === 1
      ? 'the 1 card that is not'
      : `the ${available} cards that are not`
  return `Regenerate suggestions? The ${clusters(counts.aiClusters)} marked "AI suggestion" will be replaced, and ${those} in clusters you made or changed will be grouped again. Cards in Ungrouped may be grouped again, including cards you moved there. Your clusters and their cards stay as they are. To keep the current suggestions, choose Keep suggestions first.`
}

export function keepQuestion(counts: AiBoardCounts): string {
  return counts.aiClusters === 1
    ? 'Keep the 1 suggested cluster? It becomes an ordinary cluster: the "AI suggestion" label goes away and regenerating will no longer replace it.'
    : `Keep the ${counts.aiClusters} suggested clusters? They become ordinary clusters: the "AI suggestion" label goes away and regenerating will no longer replace them.`
}

export function keptAnnouncement(kept: number): string {
  if (kept === 0) {
    return AI_NOTHING_TO_KEEP_ANNOUNCEMENT
  }
  return kept === 1
    ? 'Kept 1 cluster. Regenerating will no longer replace it.'
    : `Kept ${kept} clusters. Regenerating will no longer replace them.`
}

export interface AiSuggestionsProps {
  readonly counts: AiBoardCounts
  /** The confirmation open in the panel, if any (the board's one open form). */
  readonly confirmation: 'run' | 'keep' | null
  readonly pending: boolean
  readonly keepPending: boolean
  readonly alert: AiAlert | null
  readonly limitReached: boolean
  readonly onOpenRun: () => void
  readonly onOpenKeep: () => void
  readonly onCancel: () => void
  readonly onConfirmRun: () => void
  readonly onConfirmKeep: () => void
  readonly onTryAgain: () => void
}

/**
 * The "AI suggestions" panel (#21), for the facilitator only. Its
 * confirmations are inline groups, never a dialog. The main button keeps its
 * element through Suggest, Regenerate, and "Generating suggestions…", so
 * focus stays on it while a run is pending (`aria-disabled`, never
 * `disabled`). Only counts appear here: no card text and no author.
 */
export function AiSuggestions({
  counts,
  confirmation,
  pending,
  keepPending,
  alert,
  limitReached,
  onOpenRun,
  onOpenKeep,
  onCancel,
  onConfirmRun,
  onConfirmKeep,
  onTryAgain,
}: AiSuggestionsProps) {
  const blocked = aiBlockedReason(counts, limitReached)
  const hasSuggestions = counts.aiClusters > 0
  const showMain = pending || blocked === null
  const alertInfo = alert === null ? null : AI_CLUSTERING_ERRORS[alert.code]
  // The limit's sentence is the alert itself while that alert shows.
  const reason =
    blocked !== null && blocked === alertInfo?.copy ? null : blocked

  const onEscape = (busy: boolean) => (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onCancel()
    }
  }

  let confirmationGroup: React.ReactNode = null
  if (confirmation === 'run') {
    const regenerate = hasSuggestions
    confirmationGroup = (
      <div
        role="group"
        aria-label={regenerate ? 'Regenerate suggestions' : 'Suggest clusters'}
        className="min-w-0 space-y-3 rounded-md border p-3"
        onKeyDown={onEscape(false)}
      >
        <p className={cn('text-sm', wrapAnywhere)}>
          {regenerate ? regenerateQuestion(counts) : suggestQuestion(counts)}
        </p>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            data-ai-focus="cancel"
            className="h-auto min-h-9 max-w-full whitespace-normal"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="h-auto min-h-9 max-w-full whitespace-normal"
            onClick={onConfirmRun}
          >
            {regenerate ? 'Regenerate suggestions' : 'Suggest clusters'}
          </Button>
        </div>
      </div>
    )
  } else if (confirmation === 'keep') {
    confirmationGroup = (
      <div
        role="group"
        aria-label="Keep suggestions"
        className="min-w-0 space-y-3 rounded-md border p-3"
        onKeyDown={onEscape(keepPending)}
      >
        <p className={cn('text-sm', wrapAnywhere)}>{keepQuestion(counts)}</p>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={keepPending}
            data-ai-focus="cancel"
            className="h-auto min-h-9 max-w-full whitespace-normal"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={keepPending}
            className="h-auto min-h-9 max-w-full whitespace-normal"
            onClick={onConfirmKeep}
          >
            {keepPending ? 'Keeping…' : 'Keep suggestions'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <section
      aria-labelledby="ai-suggestions-heading"
      data-ai-panel=""
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h3 id="ai-suggestions-heading" className="text-base font-semibold">
        AI suggestions
      </h3>
      <p className={cn('text-sm', wrapAnywhere)}>{AI_PANEL_TEXT}</p>
      {reason === null ? null : (
        <p className={cn('text-sm text-muted-foreground', wrapAnywhere)}>
          {reason}
        </p>
      )}
      {alert === null ||
      alertInfo === null ||
      alertInfo.copy === null ? null : (
        <div key={alert.key} className="min-w-0 space-y-2">
          <p
            role="alert"
            className={cn('text-sm text-destructive', wrapAnywhere)}
          >
            {alertInfo.copy}
          </p>
          {alertInfo.retry && !pending ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-9 max-w-full whitespace-normal"
              onClick={onTryAgain}
            >
              Try again
            </Button>
          ) : null}
        </div>
      )}
      {confirmationGroup ?? (
        <div className="flex min-w-0 flex-wrap gap-2">
          {showMain ? (
            <Button
              type="button"
              data-ai-focus="main"
              aria-disabled={pending ? 'true' : undefined}
              className="h-auto min-h-9 max-w-full whitespace-normal aria-disabled:opacity-50"
              onClick={() => {
                if (!pending) {
                  onOpenRun()
                }
              }}
            >
              {pending
                ? 'Generating suggestions…'
                : hasSuggestions
                  ? 'Regenerate suggestions'
                  : 'Suggest clusters'}
            </Button>
          ) : null}
          {hasSuggestions ? (
            <Button
              type="button"
              variant="outline"
              data-ai-focus="keep"
              aria-disabled={pending ? 'true' : undefined}
              className="h-auto min-h-9 max-w-full whitespace-normal aria-disabled:opacity-50"
              onClick={() => {
                if (!pending) {
                  onOpenKeep()
                }
              }}
            >
              Keep suggestions
            </Button>
          ) : null}
        </div>
      )}
      {pending ? (
        <p className={cn('text-sm text-muted-foreground', wrapAnywhere)}>
          {AI_PROGRESS_TEXT}
        </p>
      ) : null}
    </section>
  )
}
