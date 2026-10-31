const projectDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeZone: 'UTC',
})

/** Formats a stored timestamp for display in UTC, e.g. "Oct 30, 2026". */
export function formatProjectDate(createdAt: string): string {
  return projectDateFormatter.format(new Date(createdAt))
}
