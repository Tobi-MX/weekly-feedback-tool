/**
 * Stable error codes raised by `create_cycle` and `close_cycle`. The database
 * raises them as the exception message; nothing else from a Postgres error is
 * ever kept, shown, or logged.
 */
export const CYCLES_ERROR_CODES = [
  'not_project_member',
  'not_project_facilitator',
  'invalid_cycle_title',
  'invalid_week_start',
  'cycle_already_open',
] as const

export type CyclesErrorCode = (typeof CYCLES_ERROR_CODES)[number] | 'unknown'

/** An error that carries only a stable code. */
export class CyclesApiError extends Error {
  readonly code: CyclesErrorCode

  constructor(code: CyclesErrorCode) {
    super(code)
    this.name = 'CyclesApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to one of the stable codes, else `unknown`. */
export function toCyclesErrorCode(
  message: string | null | undefined,
): CyclesErrorCode {
  return CYCLES_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

export function cyclesErrorCodeOf(error: unknown): CyclesErrorCode {
  return error instanceof CyclesApiError ? error.code : 'unknown'
}

/** The message shown when starting a cycle fails. */
export function createCycleErrorMessage(code: CyclesErrorCode): string {
  switch (code) {
    case 'cycle_already_open':
      return 'This project already has an open cycle.'
    case 'not_project_facilitator':
      return 'Only the facilitator can start a cycle.'
    default:
      return 'Could not start the cycle.'
  }
}

/** The message shown when closing a cycle fails. */
export function closeCycleErrorMessage(code: CyclesErrorCode): string {
  switch (code) {
    case 'not_project_facilitator':
      return 'Only the facilitator can close the cycle.'
    default:
      return 'Could not close the cycle.'
  }
}
