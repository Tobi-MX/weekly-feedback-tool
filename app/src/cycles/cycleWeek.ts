/**
 * Week boundaries for feedback cycles. A `week_start` is a calendar date with
 * no time zone, `YYYY-MM-DD`, naming the Monday of the ISO week (Monday to
 * Sunday) the cycle covers. Dates are only ever built from their year, month,
 * and day parts, so no time-zone conversion can shift the day.
 */

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const weekDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeZone: 'UTC',
})

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0')
}

function toIsoDate(year: number, monthIndex: number, day: number): string {
  // Date.UTC normalizes day overflow across months and years.
  const date = new Date(Date.UTC(year, monthIndex, day))
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
}

function parseIsoDate(value: string): {
  readonly year: number
  readonly monthIndex: number
  readonly day: number
} {
  const match = ISO_DATE_PATTERN.exec(value)
  if (!match) {
    throw new RangeError('Expected a YYYY-MM-DD date.')
  }
  return {
    year: Number(match[1]),
    monthIndex: Number(match[2]) - 1,
    day: Number(match[3]),
  }
}

/**
 * The Monday of the week containing the given **local** calendar date, as
 * `YYYY-MM-DD`. Only the local year, month, day, and weekday are read.
 */
export function weekStartOf(localDate: Date): string {
  const daysSinceMonday = (localDate.getDay() + 6) % 7
  return toIsoDate(
    localDate.getFullYear(),
    localDate.getMonth(),
    localDate.getDate() - daysSinceMonday,
  )
}

/** The `week_start` this many weeks after (or before) the given one. */
export function addWeeks(weekStart: string, weeks: number): string {
  const { year, monthIndex, day } = parseIsoDate(weekStart)
  return toIsoDate(year, monthIndex, day + weeks * 7)
}

/** Formats a `YYYY-MM-DD` date as e.g. "Oct 26, 2026" in every time zone. */
export function formatWeekStart(weekStart: string): string {
  const { year, monthIndex, day } = parseIsoDate(weekStart)
  return weekDateFormatter.format(new Date(Date.UTC(year, monthIndex, day)))
}

/** The default title for a cycle covering the given week. */
export function defaultCycleTitle(weekStart: string): string {
  return `Week of ${formatWeekStart(weekStart)}`
}
