import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { resetAuthMock } from './test/authMock'

// Every test file gets the shared auth-module mock. Tests configure results
// through `authMock`; no test needs a Supabase stack or app/.env.local.
vi.mock('./auth/authClient', async () => {
  const { authMock } = await import('./test/authMock')
  return authMock
})

beforeEach(() => {
  resetAuthMock()
  // No test may open a network connection. Tests that exercise BackendStatus
  // install their own fetch stub; every other test gets a request that never
  // settles, so even a developer's app/.env.local cannot reach the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => undefined)),
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
