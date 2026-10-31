import { randomBytes } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { createAdminClient, sweepUsers } from './admin'
import {
  HarnessSetupError,
  RLS_EMAIL_DOMAIN,
  RLS_EMAIL_PREFIX,
  assertReachable,
  resolveEnv,
  type RlsEnv,
} from './env'

declare module 'vitest' {
  export interface ProvidedContext {
    rlsEnv: RlsEnv
    rlsRunId: string
  }
}

/**
 * Runs once before any test file. It resolves the local keys, refuses a
 * non-local URL, checks the stack answers, sweeps leftovers from interrupted
 * runs, and hands a fresh run id to the workers. The returned teardown runs
 * after every file, including when tests fail.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  let env: RlsEnv
  try {
    env = await resolveEnv()
    await assertReachable(env)
  } catch (error) {
    if (error instanceof HarnessSetupError) {
      // One readable line and a non-zero exit, before any test is collected.
      process.stderr.write(`\n${error.message}\n\n`)
      process.exit(1)
    }
    throw error
  }

  const admin = createAdminClient(env)

  // Leftovers from an interrupted run. This also removes another concurrent
  // run's users, so only one suite may run against a stack at a time.
  await sweepUsers(admin, RLS_EMAIL_PREFIX, RLS_EMAIL_DOMAIN)

  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
  project.provide('rlsEnv', env)
  project.provide('rlsRunId', runId)

  return async () => {
    await sweepUsers(admin, `${RLS_EMAIL_PREFIX}${runId}-`, RLS_EMAIL_DOMAIN)
  }
}
