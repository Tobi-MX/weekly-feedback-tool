import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, vi } from 'vitest'
import { queryClient } from './lib/queryClient'
import { resetAuthMock } from './test/authMock'
import { resetMembersMock } from './test/membersMock'
import { resetProfileMock } from './test/profileMock'
import { resetProjectsMock } from './test/projectsMock'

// Every test file gets the shared auth-module mock. Tests configure results
// through `authMock`; no test needs a Supabase stack or app/.env.local.
vi.mock('./auth/authClient', async () => {
  const { authMock: mock } = await import('./test/authMock')
  return mock
})

// Profile data goes through a matching shared controller so the shell can be
// rendered without a backend. Tests configure it through `profileMock`.
vi.mock('./profile/profileApi', async () => {
  const { profileMock: mock } = await import('./test/profileMock')
  return mock
})

// Projects data uses the same shared-controller pattern, so list, detail, and
// create tests never reach the network.
vi.mock('./projects/projectsApi', async () => {
  const { projectsMock: mock } = await import('./test/projectsMock')
  return mock
})

// Membership and invite RPCs use the same pattern, so members and join tests
// never reach the network.
vi.mock('./projects/membersApi', async () => {
  const { membersMock: mock } = await import('./test/membersMock')
  return mock
})

// jsdom lacks a few browser APIs that Radix and sonner feature-detect.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })
}

if (typeof window.HTMLElement.prototype.hasPointerCapture !== 'function') {
  window.HTMLElement.prototype.hasPointerCapture = () => false
  window.HTMLElement.prototype.setPointerCapture = () => undefined
  window.HTMLElement.prototype.releasePointerCapture = () => undefined
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined
}

beforeEach(() => {
  resetAuthMock()
  resetProfileMock()
  resetProjectsMock()
  resetMembersMock()
  // Sonner keeps its toast queue outside React, so dismiss it between tests.
  toast.dismiss()
  // The QueryClient is a singleton in the app; reset it between tests so one
  // test's cached profile cannot leak into the next.
  queryClient.clear()
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
