import { Button } from '@/components/ui/button'
import { DISCUSSION_STATUSES, type DiscussionStatus } from './discussionApi'

const STATUS_LABELS: Record<DiscussionStatus, string> = {
  pending: 'Pending',
  discussed: 'Discussed',
  skipped: 'Skipped',
  deferred: 'Deferred',
}

/** The status as the board shows and announces it. */
export function discussionStatusLabel(status: DiscussionStatus): string {
  return STATUS_LABELS[status]
}

/** What the status region says once a status write has settled. */
export function statusAnnouncement(
  name: string,
  status: DiscussionStatus,
): string {
  return `${name} marked ${discussionStatusLabel(status)}.`
}

/** The line every member sees: the status as text, never colour alone. */
export function DiscussionStatusLine({ status }: { status: DiscussionStatus }) {
  return (
    <p className="text-sm">
      Status: <span className="font-medium">{STATUS_LABELS[status]}</span>
    </p>
  )
}

export interface DiscussionStatusControlProps {
  readonly clusterName: string
  readonly status: DiscussionStatus
  /** A status write is pending somewhere on the board. */
  readonly busy: boolean
  readonly onSelect: (status: DiscussionStatus) => void
}

/**
 * The facilitator's four status buttons for one topic (#25). The current
 * status is pressed; the status line above says the same in text. While any
 * status write is pending, every button is `aria-disabled` and sends
 * nothing. It is never inside a card.
 */
export function DiscussionStatusControl({
  clusterName,
  status,
  busy,
  onSelect,
}: DiscussionStatusControlProps) {
  return (
    <div
      role="group"
      aria-label={`Discussion status for ${clusterName}`}
      data-facilitator-control=""
      className="flex min-w-0 flex-wrap gap-2"
    >
      {DISCUSSION_STATUSES.map((value) => {
        const pressed = value === status
        return (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={pressed ? 'default' : 'outline'}
            aria-pressed={pressed}
            aria-disabled={busy ? 'true' : undefined}
            className="aria-disabled:opacity-50"
            onClick={() => {
              onSelect(value)
            }}
          >
            {STATUS_LABELS[value]}
          </Button>
        )
      })}
    </div>
  )
}
