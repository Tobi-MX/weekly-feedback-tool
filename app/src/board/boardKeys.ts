/**
 * The board query's key, scoped by user and cycle id. It lives apart from
 * `boardApi.ts` (which the unit tests replace with a mock) so the cycles
 * hooks can invalidate the board without importing the board's API.
 */
export const cycleBoardQueryKey = (userId: string | null, cycleId: string) =>
  ['cycle-board', userId, cycleId] as const
