import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, vi } from 'vitest'
import { queryClient } from './lib/queryClient'
import { resetActionsMock } from './test/actionsMock'
import { resetAiClusteringMock } from './test/aiClusteringMock'
import { resetAuthMock } from './test/authMock'
import { resetBoardMock } from './test/boardMock'
import { resetCardsMock } from './test/cardsMock'
import { resetCyclesMock } from './test/cyclesMock'
import { resetDiscussionMock } from './test/discussionMock'
import { resetMembersMock } from './test/membersMock'
import { resetProfileMock } from './test/profileMock'
import { resetProjectsMock } from './test/projectsMock'
import { resetVotesMock } from './test/votesMock'

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

// Cycle reads and the cycle RPCs use the same pattern, so project page tests
// never reach the network.
vi.mock('./cycles/cyclesApi', async () => {
  const { cyclesMock: mock } = await import('./test/cyclesMock')
  return mock
})

// The four card RPCs use the same pattern, so feedback form tests never reach
// the network.
vi.mock('./cards/cardsApi', async () => {
  const { cardsMock: mock } = await import('./test/cardsMock')
  return mock
})

// The board read uses the same pattern, so board tests never reach the
// network.
vi.mock('./board/boardApi', async () => {
  const { boardMock: mock } = await import('./test/boardMock')
  return mock
})

// The three cluster RPCs share the board's mock controller.
vi.mock('./board/clustersApi', async () => {
  const { boardMock: mock } = await import('./test/boardMock')
  return mock
})

// The AI clustering calls (#21) use the same pattern, so no test reaches the
// cluster-feedback Edge Function or accept_ai_clusters.
vi.mock('./board/aiClusteringApi', async () => {
  const { aiClusteringMock: mock } = await import('./test/aiClusteringMock')
  return mock
})

// The two vote writes (#23) use the same pattern, so no test reaches
// cast_vote or remove_vote.
vi.mock('./board/votesApi', async () => {
  const { votesMock: mock } = await import('./test/votesMock')
  return mock
})

// The vote totals read (#24) shares the votes mock controller, so no test
// reaches get_vote_totals. The error class and code helper stay real.
vi.mock('./board/voteTotalsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./board/voteTotalsApi')>()
  const { votesMock: mock } = await import('./test/votesMock')
  return { ...actual, fetchVoteTotals: mock.fetchVoteTotals }
})

// The discussion read and writes (#25) use the same pattern, so no test
// reaches get_cycle_discussion or a discussion write. The constants and the
// code-point helper stay real.
vi.mock('./board/discussionApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./board/discussionApi')>()
  const { discussionMock: mock } = await import('./test/discussionMock')
  return {
    ...actual,
    fetchDiscussion: mock.fetchDiscussion,
    setDiscussionStatus: mock.setDiscussionStatus,
    addNote: mock.addNote,
    updateNote: mock.updateNote,
    deleteNote: mock.deleteNote,
  }
})

// The action items read and writes (#26) use the same pattern, so no test
// reaches get_cycle_actions or an action write. The constants and the date
// helper stay real.
vi.mock('./board/actionsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./board/actionsApi')>()
  const { actionsMock: mock } = await import('./test/actionsMock')
  return {
    ...actual,
    fetchCycleActions: mock.fetchCycleActions,
    createAction: mock.createAction,
    updateAction: mock.updateAction,
    setActionStatus: mock.setActionStatus,
    deleteAction: mock.deleteAction,
  }
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
  resetCyclesMock()
  resetCardsMock()
  resetBoardMock()
  resetAiClusteringMock()
  resetVotesMock()
  resetDiscussionMock()
  resetActionsMock()
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
