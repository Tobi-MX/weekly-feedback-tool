/**
 * Cycle statuses in workflow order, matching `feedback_cycles_status_check`.
 * A cycle is open while its status is anything but `closed`; `closed` is
 * terminal. Later tasks reuse these values and labels; do not add statuses.
 */
export const CYCLE_STATUSES = [
  'collecting',
  'reveal',
  'cluster',
  'vote',
  'discuss',
  'closed',
] as const

export type CycleStatus = (typeof CYCLE_STATUSES)[number]

const LABELS: Record<CycleStatus, string> = {
  collecting: 'Collecting feedback',
  reveal: 'Revealed',
  cluster: 'Clustering',
  vote: 'Voting',
  discuss: 'Discussing',
  closed: 'Closed',
}

/** The user-facing label for a status, shown as text (never color alone). */
export function cycleStatusLabel(status: CycleStatus): string {
  return LABELS[status]
}

export function isOpenCycleStatus(status: CycleStatus): boolean {
  return status !== 'closed'
}
