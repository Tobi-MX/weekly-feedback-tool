/**
 * The only stable code `get_cycle_board` raises. Anything else (a network
 * failure, a response that does not match the strict schema) is `unknown`.
 * Nothing else from a Postgres error is ever kept, shown, or logged.
 */
export type BoardErrorCode = 'not_project_member' | 'unknown'

/** An error that carries only a stable code. */
export class BoardApiError extends Error {
  readonly code: BoardErrorCode

  constructor(code: BoardErrorCode) {
    super(code)
    this.name = 'BoardApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to a stable code, else `unknown`. */
export function toBoardErrorCode(
  message: string | null | undefined,
): BoardErrorCode {
  return message === 'not_project_member' ? 'not_project_member' : 'unknown'
}

export function boardErrorCodeOf(error: unknown): BoardErrorCode {
  return error instanceof BoardApiError ? error.code : 'unknown'
}
