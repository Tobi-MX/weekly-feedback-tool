import type { BoardCard, BoardCluster } from './boardApi'
import { cardLabelText } from './cardMove'
import {
  LIMIT_REACHED_MESSAGE,
  NAME_REQUIRED_MESSAGE,
  NAME_TAKEN_MESSAGE,
  NAME_TOO_LONG_MESSAGE,
  NAME_UNGROUPED_MESSAGE,
} from './clusterErrors'

const MAX_NAME_LENGTH = 100

/** A cycle holds at most this many clusters (#17). */
export const MAX_CLUSTERS = 50

/** The server's trim set: space, tab, line feed, carriage return. */
export function trimClusterName(raw: string): string {
  return raw.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
}

/**
 * The client's check of a name against the current board, mirroring the
 * server's rules, plus "Ungrouped". Returns the trimmed name or the inline
 * message. `ownId` is the cluster being renamed, whose own name does not
 * count as taken.
 */
export function validateClusterName(
  raw: string,
  clusters: readonly BoardCluster[],
  ownId?: string,
): { readonly name: string } | { readonly error: string } {
  const name = trimClusterName(raw)
  if (name === '') {
    return { error: NAME_REQUIRED_MESSAGE }
  }
  // Code points, as the server's char_length counts them.
  if ([...name].length > MAX_NAME_LENGTH) {
    return { error: NAME_TOO_LONG_MESSAGE }
  }
  const lower = name.toLowerCase()
  if (
    clusters.some(
      (cluster) =>
        cluster.clusterId !== ownId && cluster.name.toLowerCase() === lower,
    )
  ) {
    return { error: NAME_TAKEN_MESSAGE }
  }
  if (lower === 'ungrouped') {
    return { error: NAME_UNGROUPED_MESSAGE }
  }
  return { name }
}

/** "1 card" or "N cards". */
export function cardCount(count: number): string {
  return count === 1 ? '1 card' : `${String(count)} cards`
}

/** The split form's inline copy (#19). */
export const SPLIT_NONE_SELECTED_MESSAGE = 'Select at least one card to move.'
export function splitAllSelectedMessage(name: string): string {
  return `Leave at least one card in ${name}. To rename the cluster, use Rename.`
}
export const MERGE_TARGET_GONE_MESSAGE =
  'The cluster you chose no longer exists. Choose another.'

/** Which part of the split form an inline message is about. */
export type SplitField = 'selection' | 'name'

export interface SplitError {
  readonly field: SplitField
  readonly message: string
}

/**
 * The split form's check on submit, in the design's order: nothing selected,
 * everything selected, #17's name messages (every cluster's name counts,
 * the one being split included), then the 50-cluster limit. Returns the
 * trimmed name or the first message.
 */
export function validateSplit(
  cluster: BoardCluster,
  selectedIds: readonly string[],
  rawName: string,
  clusters: readonly BoardCluster[],
): { readonly name: string } | { readonly error: SplitError } {
  const selected = pruneSplitSelection(cluster, selectedIds)
  if (selected.length === 0) {
    return {
      error: { field: 'selection', message: SPLIT_NONE_SELECTED_MESSAGE },
    }
  }
  if (selected.length >= cluster.cardIds.length) {
    return {
      error: {
        field: 'selection',
        message: splitAllSelectedMessage(cluster.name),
      },
    }
  }
  const checked = validateClusterName(rawName, clusters)
  if ('error' in checked) {
    return { error: { field: 'name', message: checked.error } }
  }
  if (clusters.length >= MAX_CLUSTERS) {
    return { error: { field: 'name', message: LIMIT_REACHED_MESSAGE } }
  }
  return { name: checked.name }
}

/**
 * The selection without the ids that are no longer in the cluster, in the
 * cluster's order (never the order they were checked in).
 */
export function pruneSplitSelection(
  cluster: BoardCluster,
  selectedIds: readonly string[],
): readonly string[] {
  const selected = new Set(selectedIds)
  return cluster.cardIds.filter((cardId) => selected.has(cardId))
}

/** The merge form's confirmation sentence. */
export function mergeSummary(
  source: BoardCluster,
  target: BoardCluster,
): string {
  const moving = source.cardIds.length
  if (moving === 0) {
    return `"${source.name}" has no cards. Merging removes it.`
  }
  const total = target.cardIds.length + moving
  return `Move the ${cardCount(moving)} of "${source.name}" to the end of "${target.name}" and remove "${source.name}"? "${target.name}" will have ${cardCount(total)}.`
}

/** One option of the "Merge into" select. */
export function mergeOptionLabel(cluster: BoardCluster): string {
  return `${cluster.name} (${cardCount(cluster.cardIds.length)})`
}

/** A split checkbox's accessible name: only the card text, cut to 40. */
export function splitCheckboxLabel(card: BoardCard): string {
  return `Select card: ${cardLabelText(card)}`
}

/** The selection count under the split form. */
export function splitSelectionCount(selected: number, total: number): string {
  return `${String(selected)} of ${cardCount(total)} selected`
}

export function mergeAnnouncement(source: string, target: string): string {
  return `Merged cluster ${source} into ${target}.`
}

export function splitAnnouncement(count: number, name: string): string {
  return `Split ${cardCount(count)} into ${name}.`
}
