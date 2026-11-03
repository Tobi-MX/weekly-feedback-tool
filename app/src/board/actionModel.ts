import type { CycleAction } from './actionsApi'
import type { BoardCluster, CycleBoard } from './boardApi'

/** An action with its related topic (null for no related topic). */
export interface ActionWithTopic {
  readonly action: CycleAction
  readonly topic: BoardCluster | null
}

/**
 * Each action, in server order, with its cluster from the board. Null (a
 * load error) when an action names a cluster the board does not have, or an
 * `action_id` repeats.
 */
export function actionsWithTopics(
  board: CycleBoard,
  actions: readonly CycleAction[],
): readonly ActionWithTopic[] | null {
  const clusters = new Map(
    board.clusters.map((cluster) => [cluster.clusterId, cluster]),
  )
  const seen = new Set<string>()
  const result: ActionWithTopic[] = []
  for (const action of actions) {
    if (seen.has(action.actionId)) {
      return null
    }
    seen.add(action.actionId)
    let topic: BoardCluster | null = null
    if (action.clusterId !== null) {
      const cluster = clusters.get(action.clusterId)
      if (cluster === undefined) {
        return null
      }
      topic = cluster
    }
    result.push({ action, topic })
  }
  return result
}

/** The viewer's local calendar date as `YYYY-MM-DD`. */
export function localDateIso(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Overdue is a client-only label: an open action whose due date is before
 * the viewer's local date. A done action is never overdue, and a due date of
 * today is not overdue.
 */
export function isOverdue(
  action: Pick<CycleAction, 'status' | 'dueDate'>,
  todayIso: string,
): boolean {
  return (
    action.status === 'open' &&
    action.dueDate !== null &&
    action.dueDate < todayIso
  )
}

const dueDateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

/**
 * `Nov 12, 2026` for `2026-11-12`. The date is read and formatted in UTC, so
 * it never shifts a day with the viewer's time zone.
 */
export function formatDueDate(iso: string): string {
  return dueDateFormat.format(new Date(`${iso}T00:00:00Z`))
}
