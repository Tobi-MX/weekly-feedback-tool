import { expect } from 'vitest'

/** The error part of a PostgREST or RPC response. */
export interface PgError {
  readonly code: string
  readonly message: string
}

/** A supabase-js query or RPC response, narrowed to what the suite checks. */
export interface DbResult<T> {
  readonly data: T | null
  readonly error: PgError | null
}

/**
 * Every helper checks both `data` and `error`, so no test asserts only one of
 * them. They throw a Vitest assertion error on the wrong outcome.
 */

/** Success with exactly `n` rows. Returns the rows. */
export function expectRows<T>(
  result: DbResult<readonly T[]>,
  n: number,
): readonly T[] {
  expect(result.error, 'expected no error').toBeNull()
  expect(Array.isArray(result.data), 'expected an array of rows').toBe(true)
  const rows = result.data ?? []
  expect(rows, `expected ${n} row(s)`).toHaveLength(n)
  return rows
}

/** Success with no rows: RLS filtered them out. */
export function expectNoRows(result: DbResult<readonly unknown[]>): void {
  expect(result.error, 'expected no error').toBeNull()
  expect(result.data, 'expected no rows').toEqual([])
}

/**
 * Failure with a Postgres error code (and the exact message when given): a
 * grant, a policy check, or an RPC denied the call.
 */
export function expectPgError(
  result: DbResult<unknown>,
  code: string,
  message?: string,
): void {
  expect(result.data, 'expected no data').toBeNull()
  expect(result.error, `expected error ${code}`).not.toBeNull()
  expect(result.error?.code, 'error code').toBe(code)
  if (message !== undefined) {
    expect(result.error?.message, 'error message').toBe(message)
  }
}
