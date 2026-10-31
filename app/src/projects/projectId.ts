// A non-UUID id is rejected before it reaches the database, so an unknown or
// malformed id becomes the same not-found state instead of a database error.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isProjectId(value: string): boolean {
  return UUID_PATTERN.test(value)
}
