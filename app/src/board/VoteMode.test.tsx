import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import type { CycleStatus } from '../cycles/cycleStatus'
import { queryClient } from '../lib/queryClient'
import type { ProjectMember } from '../projects/membersApi'
import { deferred, mockRestoredSession } from '../test/authMock'
import { boardMock } from '../test/boardMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { votesMock } from '../test/votesMock'
import type { BoardCard, BoardCluster, CycleBoard, MyVote } from './boardApi'
import {
  VOTE_ERROR_CODES,
  voteErrorMessage,
  VotesApiError,
  type VoteErrorCode,
  type VoteOperation,
} from './voteErrors'
import type { VoteResult } from './votesApi'
import {
  NO_VOTES_LEFT_ANNOUNCEMENT,
  VOTE_INTRO,
  VOTE_TOTALS_HIDDEN,
  VOTES_USED_UP,
  VOTES_WAITING,
} from './VoteMode'
import { renderApp } from '../test/renderApp'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/board`
const NOT_FOUND = 'Cycle not found or you do not have access.'

const cycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'vote',
}

// No digits in any card text or author, so the hidden-totals check can count
// every number on the board.
const U1: BoardCard = {
  cardId: 'f0000000-0000-4000-8000-000000000001',
  category: 'start',
  text: 'Start pairing',
  isAnonymous: false,
  isMine: false,
  authorDisplayName: 'Grace',
}
const U2: BoardCard = {
  cardId: 'a0000000-0000-4000-8000-000000000002',
  category: 'continue',
  text: 'Continue demos',
  isAnonymous: true,
}
const P1: BoardCard = {
  cardId: 'b0000000-0000-4000-8000-000000000003',
  category: 'stop',
  text: 'Stop late merges',
  isAnonymous: false,
  isMine: true,
  authorDisplayName: 'Ada',
}
const P2: BoardCard = {
  cardId: 'c0000000-0000-4000-8000-000000000004',
  category: 'start',
  text: 'Start writing ADRs',
  isAnonymous: true,
}
const D1: BoardCard = {
  cardId: 'e0000000-0000-4000-8000-000000000005',
  category: 'stop',
  text: 'Stop skipping docs',
  isAnonymous: false,
  isMine: false,
  authorDisplayName: null,
}
const CARDS = [U1, U2, P1, P2, D1]
const CARD_WORDS = [
  ...CARDS.map((card) => card.text),
  'Grace',
  'Ada',
  'Anonymous',
  'Deleted user',
]

// The server's order, not alphabetical and not by id.
const PROCESS: BoardCluster = {
  clusterId: 'd1000000-0000-4000-8000-000000000001',
  name: 'Process',
  source: 'manual',
  cardIds: [P1.cardId, P2.cardId],
}
const TOOLS: BoardCluster = {
  clusterId: 'a1000000-0000-4000-8000-000000000002',
  name: 'Tools',
  source: 'ai',
  cardIds: [],
}
const DOCS: BoardCluster = {
  clusterId: 'b1000000-0000-4000-8000-000000000003',
  name: 'Docs',
  source: 'manual',
  cardIds: [D1.cardId],
}
const CLUSTERS = [PROCESS, TOOLS, DOCS]

type Votes = ReadonlyArray<readonly [BoardCluster, number]>

interface BoardOptions {
  readonly status?: CycleStatus
  readonly clusters?: readonly BoardCluster[]
  readonly cards?: readonly BoardCard[]
  readonly votes?: Votes
}

function boardOf(options: BoardOptions = {}): CycleBoard {
  const votes = options.votes ?? []
  const myVotes: MyVote[] = votes.map(([cluster, voteCount]) => ({
    clusterId: cluster.clusterId,
    voteCount,
  }))
  const used = votes.reduce((sum, [, count]) => sum + count, 0)
  const status = options.status ?? 'vote'
  return {
    cycleId: CYCLE_ID,
    status,
    isRevealed: status !== 'collecting',
    cards: options.cards ?? CARDS,
    clusters: options.clusters ?? CLUSTERS,
    myVotes,
    votesRemaining: 3 - used,
  }
}

function result(
  cluster: BoardCluster,
  voteCount: number,
  votesRemaining: number,
): VoteResult {
  return { clusterId: cluster.clusterId, voteCount, votesRemaining }
}

function memberRow(overrides: Partial<ProjectMember>): ProjectMember {
  return {
    userId: 'user-1',
    displayName: 'Dev User',
    role: 'member',
    isOwner: false,
    isMe: true,
    joinedAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  }
}

const asFacilitator = [memberRow({ role: 'facilitator', isOwner: true })]
const asMember = [
  memberRow({}),
  memberRow({
    userId: 'user-2',
    displayName: 'Fac',
    role: 'facilitator',
    isMe: false,
    isOwner: true,
  }),
]
const asOwnerNotFacilitator = [
  memberRow({ isOwner: true }),
  memberRow({
    userId: 'user-2',
    displayName: 'Fac',
    role: 'facilitator',
    isMe: false,
  }),
]

interface SetupOptions {
  readonly board?: CycleBoard
  readonly members?: ProjectMember[] | 'loading' | 'failed'
}

function setup(options: SetupOptions = {}) {
  mockRestoredSession('dev@example.com', 'user-1')
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  const board = options.board ?? boardOf()
  cyclesMock.fetchCycle.mockResolvedValue({ ...cycle, status: board.status })
  boardMock.fetchCycleBoard.mockResolvedValue(board)
  const members = options.members ?? asMember
  if (members === 'loading') {
    membersMock.fetchProjectMembers.mockReturnValue(
      new Promise(() => undefined),
    )
  } else if (members === 'failed') {
    membersMock.fetchProjectMembers.mockRejectedValue(new Error('offline'))
  } else {
    membersMock.fetchProjectMembers.mockResolvedValue(members)
  }
  return renderApp({ initialEntries: [PATH] })
}

/** The server's next board, for every refetch from now on. */
function serverBoard(board: CycleBoard) {
  boardMock.fetchCycleBoard.mockResolvedValue(board)
}

/** The vote board, once the first board read is in. */
async function voteBoard(): Promise<HTMLElement> {
  // The first render of a file is slow on a loaded machine.
  return screen.findByTestId('vote-board', {}, { timeout: 5000 })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', {
    level: 3,
    name: new RegExp(`^${escapeRegExp(name)} \\(`),
  })
  const element = heading.closest('section')
  if (element === null) {
    throw new Error(`no section for ${name}`)
  }
  return element
}

function ownVotes(name: string): string | null {
  return within(section(name)).getByText(/^Your votes: \d$/).textContent
}

function addButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: `Add vote to ${name}` })
}

function removeButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: `Remove vote from ${name}` })
}

const COUNTER = /^You have (\d votes? left|used all 3 votes)\.$/

function counterText(): string | null {
  return screen.getByText(COUNTER).textContent
}

function statusRegion(): HTMLElement {
  return within(screen.getByTestId('vote-board')).getByRole('status')
}

function voteButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', {
    name: /^(Add vote to|Remove vote from) /,
  })
}

/** Lets a mutation that was (wrongly) started reach its mutationFn. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** A focus, poll, event, or reconnect: the board is re-read. */
async function refetchBoard(): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['cycle-board'] })
  })
}

function added(name: string, count: number, left: number): string {
  return `Vote added to ${name}. Your votes on it: ${count}. Votes left: ${left}.`
}

function removed(name: string, count: number, left: number): string {
  return `Vote removed from ${name}. Your votes on it: ${count}. Votes left: ${left}.`
}

/** Waits until the last write has settled and its announcement is in. */
async function announced(text: string): Promise<void> {
  await waitFor(() => {
    expect(statusRegion()).toHaveTextContent(text)
  })
  expect(statusRegion().textContent).toBe(text)
}

describe('vote mode layout', () => {
  it('shows the h2, intro, notice, counter, and each cluster in the response order with its votes, buttons, and cards', async () => {
    setup()
    const board = await voteBoard()

    expect(
      screen.getByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()
    expect(within(board).getByText(VOTE_INTRO)).toBeInTheDocument()
    expect(within(board).getByText(VOTE_TOTALS_HIDDEN)).toBeInTheDocument()
    expect(counterText()).toBe('You have 3 votes left.')
    expect(screen.queryByTestId('mode-placeholder')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Voting is not available yet.'),
    ).not.toBeInTheDocument()

    // The order in the DOM: intro, notice, counter, status region, clusters.
    const text = board.textContent ?? ''
    expect(text.indexOf(VOTE_INTRO)).toBeLessThan(
      text.indexOf(VOTE_TOTALS_HIDDEN),
    )
    expect(text.indexOf(VOTE_TOTALS_HIDDEN)).toBeLessThan(
      text.indexOf('You have 3 votes left.'),
    )

    expect(
      within(board)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Process (2)',
      'Tools (0) AI suggestion',
      'Docs (1)',
      'Ungrouped (2)',
    ])
    expect(within(section('Process')).queryByText('AI suggestion')).toBeNull()
    expect(within(section('Docs')).queryByText('AI suggestion')).toBeNull()

    for (const cluster of CLUSTERS) {
      const element = section(cluster.name)
      expect(ownVotes(cluster.name)).toBe('Your votes: 0')
      expect(
        within(element)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Add vote', 'Remove vote'])
    }
    expect(
      within(section('Process'))
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-card-id')),
    ).toEqual([P1.cardId, P2.cardId])
    expect(
      within(section('Tools')).getByText('No cards in this cluster.'),
    ).toBeInTheDocument()

    // Read-only: no cluster form, Rename, Delete, Merge, Split, or Move.
    expect(screen.queryByRole('form', { name: 'New cluster' })).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: /Rename|Delete|Merge|Split|Move card|Suggest/,
      }),
    ).toBeNull()
    expect(board.querySelector('[draggable], input, select')).toBeNull()
  })

  it.each([
    [[], 'You have 3 votes left.'],
    [[[PROCESS, 1]], 'You have 2 votes left.'],
    [
      [
        [PROCESS, 1],
        [TOOLS, 1],
      ],
      'You have 1 vote left.',
    ],
    [
      [
        [PROCESS, 2],
        [DOCS, 1],
      ],
      VOTES_USED_UP,
    ],
  ] as const)('with votes %j the counter reads "%s"', async (votes, text) => {
    setup({ board: boardOf({ votes }) })
    await voteBoard()

    expect(counterText()).toBe(text)
    if (text === VOTES_USED_UP) {
      expect(screen.getByText(VOTES_WAITING)).toBeInTheDocument()
      expect(VOTES_USED_UP).toBe('You have used all 3 votes.')
      expect(VOTES_WAITING).toBe(
        'Voting closes when everyone has voted or the facilitator closes it. Until then, you can remove a vote and place it on another topic.',
      )
    } else {
      expect(screen.queryByText(VOTES_WAITING)).not.toBeInTheDocument()
    }
    // The counter is plain text, not a live region.
    expect(screen.getByText(COUNTER).closest('[role], [aria-live]')).toBe(null)
  })

  it('names each button for its cluster, keeps both reachable with Tab, and works with Enter and Space', async () => {
    setup()
    await voteBoard()

    const names = voteButtons().map((button) =>
      button.getAttribute('aria-label'),
    )
    expect(names).toEqual([
      'Add vote to Process',
      'Remove vote from Process',
      'Add vote to Tools',
      'Remove vote from Tools',
      'Add vote to Docs',
      'Remove vote from Docs',
    ])
    expect(new Set(names).size).toBe(names.length)
    for (const button of voteButtons()) {
      expect(button.tagName).toBe('BUTTON')
      expect(button).toHaveAttribute('type', 'button')
      expect(button.tabIndex).toBe(0)
      expect(button).not.toHaveAttribute('disabled')
      // The visible text is part of the accessible name.
      expect(button.getAttribute('aria-label')).toContain(
        button.textContent ?? '',
      )
    }

    // Enter on a native button is a click.
    serverBoard(boardOf({ votes: [[TOOLS, 1]] }))
    votesMock.castVote.mockResolvedValueOnce(result(TOOLS, 1, 2))
    addButton('Tools').focus()
    fireEvent.keyDown(addButton('Tools'), { key: 'Enter' })
    fireEvent.click(addButton('Tools'))
    await announced(added('Tools', 1, 2))
    expect(votesMock.castVote).toHaveBeenCalledWith(CYCLE_ID, TOOLS.clusterId)

    // So is Space.
    serverBoard(boardOf())
    votesMock.removeVote.mockResolvedValueOnce(result(TOOLS, 0, 3))
    await waitFor(() => {
      expect(removeButton('Tools')).not.toHaveAttribute('aria-disabled')
    })
    removeButton('Tools').focus()
    fireEvent.keyDown(removeButton('Tools'), { key: ' ' })
    fireEvent.keyUp(removeButton('Tools'), { key: ' ' })
    fireEvent.click(removeButton('Tools'))
    await announced(removed('Tools', 0, 3))
    expect(votesMock.removeVote).toHaveBeenCalledWith(CYCLE_ID, TOOLS.clusterId)
  })
})

describe('adding and removing votes', () => {
  it('Add shows the vote at once, then announces the reply once the refetched board is in', async () => {
    setup()
    await voteBoard()
    const pending = deferred<VoteResult>()
    votesMock.castVote.mockReturnValue(pending.promise)

    fireEvent.click(addButton('Process'))

    await waitFor(() => {
      expect(votesMock.castVote).toHaveBeenCalledTimes(1)
    })
    expect(votesMock.castVote).toHaveBeenCalledWith(CYCLE_ID, PROCESS.clusterId)
    await waitFor(() => {
      expect(ownVotes('Process')).toBe('Your votes: 1')
    })
    expect(counterText()).toBe('You have 2 votes left.')
    expect(statusRegion()).toHaveTextContent('')

    serverBoard(boardOf({ votes: [[PROCESS, 1]] }))
    pending.resolve(result(PROCESS, 1, 2))

    await announced(added('Process', 1, 2))
    expect(statusRegion().querySelectorAll('span')).toHaveLength(1)
    expect(ownVotes('Process')).toBe('Your votes: 1')
    expect(counterText()).toBe('You have 2 votes left.')
    expect(votesMock.castVote).toHaveBeenCalledTimes(1)
    expect(votesMock.removeVote).not.toHaveBeenCalled()
  })

  it('stacks three votes on one cluster, one after the other', async () => {
    setup()
    await voteBoard()

    for (const count of [1, 2, 3]) {
      await waitFor(() => {
        expect(addButton('Process')).not.toHaveAttribute('aria-disabled')
      })
      serverBoard(boardOf({ votes: [[PROCESS, count]] }))
      votesMock.castVote.mockResolvedValueOnce(
        result(PROCESS, count, 3 - count),
      )
      fireEvent.click(addButton('Process'))
      await announced(added('Process', count, 3 - count))
      await waitFor(() => {
        expect(ownVotes('Process')).toBe(`Your votes: ${count}`)
      })
    }

    expect(votesMock.castVote).toHaveBeenCalledTimes(3)
    expect(counterText()).toBe(VOTES_USED_UP)
    expect(screen.getByText(VOTES_WAITING)).toBeInTheDocument()
    for (const cluster of CLUSTERS) {
      expect(addButton(cluster.name)).toHaveAttribute('aria-disabled', 'true')
    }
    expect(removeButton('Process')).not.toHaveAttribute('aria-disabled')
  })

  it('spreads three votes over three clusters', async () => {
    setup()
    await voteBoard()
    const steps: Votes[] = [
      [[PROCESS, 1]],
      [
        [PROCESS, 1],
        [TOOLS, 1],
      ],
      [
        [PROCESS, 1],
        [TOOLS, 1],
        [DOCS, 1],
      ],
    ]
    for (const [index, votes] of steps.entries()) {
      const cluster = CLUSTERS[index] as BoardCluster
      await waitFor(() => {
        expect(addButton(cluster.name)).not.toHaveAttribute('aria-disabled')
      })
      serverBoard(boardOf({ votes }))
      votesMock.castVote.mockResolvedValueOnce(result(cluster, 1, 2 - index))
      fireEvent.click(addButton(cluster.name))
      await announced(added(cluster.name, 1, 2 - index))
    }
    await waitFor(() => {
      expect(counterText()).toBe(VOTES_USED_UP)
    })
    for (const cluster of CLUSTERS) {
      expect(ownVotes(cluster.name)).toBe('Your votes: 1')
    }
  })

  it('Remove shows one fewer vote at once and announces the reply; Remove at 0 sends nothing', async () => {
    setup({ board: boardOf({ votes: [[PROCESS, 2]] }) })
    await voteBoard()
    expect(removeButton('Tools')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(removeButton('Tools'))
    await flush()
    expect(votesMock.removeVote).not.toHaveBeenCalled()
    expect(statusRegion()).toHaveTextContent('')

    const pending = deferred<VoteResult>()
    votesMock.removeVote.mockReturnValue(pending.promise)
    fireEvent.click(removeButton('Process'))

    await waitFor(() => {
      expect(votesMock.removeVote).toHaveBeenCalledTimes(1)
    })
    expect(votesMock.removeVote).toHaveBeenCalledWith(
      CYCLE_ID,
      PROCESS.clusterId,
    )
    await waitFor(() => {
      expect(ownVotes('Process')).toBe('Your votes: 1')
    })
    expect(counterText()).toBe('You have 2 votes left.')

    serverBoard(boardOf({ votes: [[PROCESS, 1]] }))
    pending.resolve(result(PROCESS, 1, 2))
    await announced(removed('Process', 1, 2))
    expect(votesMock.castVote).not.toHaveBeenCalled()
  })

  it('moves a vote: Remove on X, then Add on Y', async () => {
    setup({ board: boardOf({ votes: [[PROCESS, 3]] }) })
    await voteBoard()

    serverBoard(boardOf({ votes: [[PROCESS, 2]] }))
    votesMock.removeVote.mockResolvedValueOnce(result(PROCESS, 2, 1))
    fireEvent.click(removeButton('Process'))
    await announced(removed('Process', 2, 1))
    await waitFor(() => {
      expect(addButton('Tools')).not.toHaveAttribute('aria-disabled')
    })

    serverBoard(
      boardOf({
        votes: [
          [PROCESS, 2],
          [TOOLS, 1],
        ],
      }),
    )
    votesMock.castVote.mockResolvedValueOnce(result(TOOLS, 1, 0))
    fireEvent.click(addButton('Tools'))
    await announced(added('Tools', 1, 0))

    await waitFor(() => {
      expect(counterText()).toBe(VOTES_USED_UP)
    })
    expect(ownVotes('Process')).toBe('Your votes: 2')
    expect(ownVotes('Tools')).toBe('Your votes: 1')
    expect(ownVotes('Docs')).toBe('Your votes: 0')
  })

  it('at 0 left keeps Remove where the caller has votes; an unavailable Add sends nothing, explains, and keeps focus', async () => {
    setup({
      board: boardOf({
        votes: [
          [PROCESS, 2],
          [TOOLS, 1],
        ],
      }),
    })
    await voteBoard()

    expect(removeButton('Process')).not.toHaveAttribute('aria-disabled')
    expect(removeButton('Tools')).not.toHaveAttribute('aria-disabled')
    expect(removeButton('Docs')).toHaveAttribute('aria-disabled', 'true')
    for (const cluster of CLUSTERS) {
      expect(addButton(cluster.name)).toHaveAttribute('aria-disabled', 'true')
    }

    addButton('Docs').focus()
    fireEvent.click(addButton('Docs'))
    await flush()

    expect(votesMock.castVote).not.toHaveBeenCalled()
    expect(statusRegion().textContent).toBe(NO_VOTES_LEFT_ANNOUNCEMENT)
    expect(NO_VOTES_LEFT_ANNOUNCEMENT).toBe(
      'You have no votes left. Remove a vote from another topic to place it here.',
    )
    expect(document.activeElement).toBe(addButton('Docs'))
  })

  it('sends one write at a time: every other press while it is pending sends nothing', async () => {
    setup({ board: boardOf({ votes: [[DOCS, 1]] }) })
    await voteBoard()
    const pending = deferred<VoteResult>()
    votesMock.castVote.mockReturnValue(pending.promise)

    // A double click lands before React re-renders: the ref guard holds.
    act(() => {
      addButton('Process').click()
      addButton('Process').click()
    })
    await waitFor(() => {
      expect(votesMock.castVote).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      expect(addButton('Process')).toHaveAttribute('aria-disabled', 'true')
    })
    for (const button of voteButtons()) {
      expect(button).toHaveAttribute('aria-disabled', 'true')
    }

    // A second click, Enter, a double click, and another cluster's buttons.
    fireEvent.click(addButton('Process'))
    fireEvent.keyDown(addButton('Process'), { key: 'Enter' })
    fireEvent.click(addButton('Process'))
    fireEvent.click(addButton('Process'))
    fireEvent.click(addButton('Process'))
    fireEvent.click(addButton('Tools'))
    fireEvent.click(removeButton('Process'))
    fireEvent.click(removeButton('Docs'))
    await flush()
    expect(votesMock.castVote).toHaveBeenCalledTimes(1)
    expect(votesMock.removeVote).not.toHaveBeenCalled()
    // A press while pending announces nothing either.
    expect(statusRegion()).toHaveTextContent('')

    serverBoard(
      boardOf({
        votes: [
          [PROCESS, 1],
          [DOCS, 1],
        ],
      }),
    )
    pending.resolve(result(PROCESS, 1, 1))
    await announced(added('Process', 1, 1))
    await waitFor(() => {
      expect(addButton('Process')).not.toHaveAttribute('aria-disabled')
    })

    votesMock.castVote.mockResolvedValueOnce(result(PROCESS, 2, 0))
    fireEvent.click(addButton('Process'))
    await waitFor(() => {
      expect(votesMock.castVote).toHaveBeenCalledTimes(2)
    })
  })

  it('never counts a vote twice when a refetch lands while the write is pending', async () => {
    setup()
    await voteBoard()
    const pending = deferred<VoteResult>()
    votesMock.castVote.mockReturnValue(pending.promise)

    fireEvent.click(addButton('Process'))
    await waitFor(() => {
      expect(ownVotes('Process')).toBe('Your votes: 1')
    })

    // A refetch that already holds the new vote.
    serverBoard(boardOf({ votes: [[PROCESS, 1]] }))
    await refetchBoard()
    expect(ownVotes('Process')).toBe('Your votes: 1')
    expect(counterText()).toBe('You have 2 votes left.')

    // A refetch that does not.
    serverBoard(boardOf())
    await refetchBoard()
    expect(ownVotes('Process')).toBe('Your votes: 1')
    expect(counterText()).toBe('You have 2 votes left.')

    serverBoard(boardOf({ votes: [[PROCESS, 1]] }))
    pending.resolve(result(PROCESS, 1, 2))
    await announced(added('Process', 1, 2))
    expect(ownVotes('Process')).toBe('Your votes: 1')
    expect(counterText()).toBe('You have 2 votes left.')
  })
})

describe('failures', () => {
  it.each([
    ['add', 'Could not add your vote.'],
    ['remove', 'Could not remove your vote.'],
  ] as const)(
    'a failed %s rolls back at once, before the refetch, toasts once, and re-reads the board',
    async (operation, message) => {
      setup({ board: boardOf({ votes: [[PROCESS, 1]] }) })
      await voteBoard()
      const pending = deferred<VoteResult>()
      const write =
        operation === 'add' ? votesMock.castVote : votesMock.removeVote
      write.mockReturnValue(pending.promise)

      fireEvent.click(
        operation === 'add' ? addButton('Process') : removeButton('Process'),
      )
      await waitFor(() => {
        expect(ownVotes('Process')).toBe(
          operation === 'add' ? 'Your votes: 2' : 'Your votes: 0',
        )
      })

      // The refetch the failure starts never answers here, so what shows
      // next comes from the rollback alone.
      const reads = boardMock.fetchCycleBoard.mock.calls.length
      boardMock.fetchCycleBoard.mockReturnValue(new Promise(() => undefined))
      pending.reject(new VotesApiError('unknown'))

      await waitFor(() => {
        expect(ownVotes('Process')).toBe('Your votes: 1')
      })
      expect(counterText()).toBe('You have 2 votes left.')
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getAllByText(message)).toHaveLength(1)
      await waitFor(() => {
        expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(
          reads,
        )
      })
      // Errors are not announced in the status region.
      expect(statusRegion()).toHaveTextContent('')
    },
  )

  const CASES: Array<[VoteErrorCode, VoteOperation]> = [
    ...VOTE_ERROR_CODES,
    'unknown' as const,
  ]
    .filter((code) => code !== 'not_project_member')
    .flatMap((code) => [
      [code, 'add'] as [VoteErrorCode, VoteOperation],
      [code, 'remove'] as [VoteErrorCode, VoteOperation],
    ])

  const EXPECTED: Record<string, string> = {
    'cycle_not_voting/add': 'Votes can only be changed during the Vote stage.',
    'cycle_not_voting/remove':
      'Votes can only be changed during the Vote stage.',
    'cluster_not_found/add': 'This cluster no longer exists.',
    'cluster_not_found/remove': 'This cluster no longer exists.',
    'no_votes_remaining/add':
      'You have already used all 3 votes. Remove one to vote again.',
    'no_votes_remaining/remove': 'Could not remove your vote.',
    'no_vote_to_remove/add': 'Could not add your vote.',
    'no_vote_to_remove/remove': 'You have no vote on this cluster to remove.',
    'unknown/add': 'Could not add your vote.',
    'unknown/remove': 'Could not remove your vote.',
  }

  it.each(CASES)('%s on %s shows its exact toast', async (code, operation) => {
    setup({ board: boardOf({ votes: [[PROCESS, 1]] }) })
    await voteBoard()
    const write =
      operation === 'add' ? votesMock.castVote : votesMock.removeVote
    write.mockRejectedValue(new VotesApiError(code))

    fireEvent.click(
      operation === 'add' ? addButton('Process') : removeButton('Process'),
    )

    const message = EXPECTED[`${code}/${operation}`] ?? ''
    expect(voteErrorMessage(code, operation)).toBe(message)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getAllByText(message)).toHaveLength(1)
    await waitFor(() => {
      expect(ownVotes('Process')).toBe('Your votes: 1')
    })
    expect(statusRegion()).toHaveTextContent('')
  })

  it.each(['add', 'remove'] as const)(
    'not_project_member on %s shows the not-found state and no toast',
    async (operation) => {
      setup({ board: boardOf({ votes: [[PROCESS, 1]] }) })
      await voteBoard()
      const write =
        operation === 'add' ? votesMock.castVote : votesMock.removeVote
      write.mockRejectedValue(new VotesApiError('not_project_member'))

      fireEvent.click(
        operation === 'add' ? addButton('Process') : removeButton('Process'),
      )

      expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
      expect(screen.queryByTestId('vote-board')).not.toBeInTheDocument()
      expect(voteButtons()).toHaveLength(0)
      for (const message of Object.values(EXPECTED)) {
        expect(screen.queryByText(message)).not.toBeInTheDocument()
      }
    },
  )

  it('a stale tab: Add with 1 left gets no_votes_remaining, rolls back, toasts, and the refetch shows 0 left', async () => {
    setup({ board: boardOf({ votes: [[PROCESS, 2]] }) })
    await voteBoard()
    expect(counterText()).toBe('You have 1 vote left.')

    // Another tab of the same user already used the last vote.
    serverBoard(
      boardOf({
        votes: [
          [PROCESS, 2],
          [DOCS, 1],
        ],
      }),
    )
    votesMock.castVote.mockRejectedValue(
      new VotesApiError('no_votes_remaining'),
    )
    fireEvent.click(addButton('Tools'))

    await waitFor(() => {
      expect(votesMock.castVote).toHaveBeenCalledTimes(1)
    })
    expect(
      await screen.findByText(
        'You have already used all 3 votes. Remove one to vote again.',
      ),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(counterText()).toBe(VOTES_USED_UP)
    })
    expect(screen.getByText(VOTES_WAITING)).toBeInTheDocument()
    expect(ownVotes('Tools')).toBe('Your votes: 0')
    expect(ownVotes('Docs')).toBe('Your votes: 1')
    expect(statusRegion()).toHaveTextContent('')
  })

  it('a reply that does not parse is unknown; the refetch shows the vote if it landed', async () => {
    setup()
    await voteBoard()
    serverBoard(boardOf({ votes: [[TOOLS, 1]] }))
    votesMock.castVote.mockRejectedValue(new VotesApiError('unknown'))

    fireEvent.click(addButton('Tools'))

    expect(
      await screen.findByText('Could not add your vote.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(counterText()).toBe('You have 2 votes left.')
    })
    expect(ownVotes('Tools')).toBe('Your votes: 1')
  })
})

describe('refetches, focus, and announcements', () => {
  it("another tab's change updates the counts and counter silently", async () => {
    setup()
    await voteBoard()

    serverBoard(boardOf({ votes: [[DOCS, 2]] }))
    await refetchBoard()

    await waitFor(() => {
      expect(ownVotes('Docs')).toBe('Your votes: 2')
    })
    expect(counterText()).toBe('You have 1 vote left.')
    expect(statusRegion()).toHaveTextContent('')
    expect(votesMock.castVote).not.toHaveBeenCalled()
  })

  it('keeps focus on the pressed button after the last vote, a failure, and a refetch', async () => {
    setup({ board: boardOf({ votes: [[PROCESS, 2]] }) })
    await voteBoard()

    // A successful add that uses the last vote.
    serverBoard(
      boardOf({
        votes: [
          [PROCESS, 2],
          [TOOLS, 1],
        ],
      }),
    )
    votesMock.castVote.mockResolvedValueOnce(result(TOOLS, 1, 0))
    addButton('Tools').focus()
    fireEvent.click(addButton('Tools'))
    await announced(added('Tools', 1, 0))
    await waitFor(() => {
      expect(addButton('Tools')).toHaveAttribute('aria-disabled', 'true')
    })
    expect(document.activeElement).toBe(addButton('Tools'))

    // A failure.
    votesMock.removeVote.mockRejectedValueOnce(new VotesApiError('unknown'))
    removeButton('Process').focus()
    fireEvent.click(removeButton('Process'))
    expect(
      await screen.findByText('Could not remove your vote.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(removeButton('Process')).not.toHaveAttribute('aria-disabled')
    })
    expect(document.activeElement).toBe(removeButton('Process'))

    // A refetch.
    await refetchBoard()
    expect(document.activeElement).toBe(removeButton('Process'))
  })

  it('never repeats an announcement on re-render, and inserts the same text twice when it is said twice', async () => {
    setup({ board: boardOf({ votes: [[PROCESS, 3]] }) })
    await voteBoard()

    fireEvent.click(addButton('Docs'))
    const first = statusRegion().querySelector('span')
    expect(first?.textContent).toBe(NO_VOTES_LEFT_ANNOUNCEMENT)

    // A re-render keeps the same node: nothing is read again.
    await refetchBoard()
    expect(statusRegion().querySelector('span')).toBe(first)

    // The same announcement again is a new node, so it is read again.
    fireEvent.click(addButton('Docs'))
    const second = statusRegion().querySelector('span')
    expect(second?.textContent).toBe(NO_VOTES_LEFT_ANNOUNCEMENT)
    expect(second).not.toBe(first)
    expect(statusRegion().querySelectorAll('span')).toHaveLength(1)
  })
})

describe('stage changes', () => {
  // #24: leaving vote for discuss while focus is on a vote control that
  // vanishes moves focus to the Discuss h2 (DiscussMode.test.tsx); leaving
  // for closed moves nothing.
  it.each([['closed', 'Closed', 'This retrospective is closed.']] as const)(
    'leaving vote for %s while idle removes every vote control and does not move focus',
    async (status, heading, copy) => {
      setup({ board: boardOf({ votes: [[PROCESS, 1]] }) })
      await voteBoard()
      addButton('Process').focus()

      serverBoard(boardOf({ status, votes: [[PROCESS, 1]] }))
      await refetchBoard()

      expect(
        await screen.findByRole('heading', { level: 2, name: heading }),
      ).toBeInTheDocument()
      expect(await screen.findByText(`Stage: ${heading}`)).toBeInTheDocument()
      expect(screen.getByText(copy)).toBeInTheDocument()
      expect(voteButtons()).toHaveLength(0)
      expect(screen.queryByTestId('vote-board')).not.toBeInTheDocument()
      expect(screen.queryByText(/^Your votes/)).not.toBeInTheDocument()
      expect(screen.queryByText(VOTE_TOTALS_HIDDEN)).not.toBeInTheDocument()
      // Focus was on a control that vanished; nothing moved it anywhere.
      expect(document.activeElement).toBe(document.body)
    },
  )

  it('a cast that fails with cycle_not_voting after the stage moved on only toasts', async () => {
    setup()
    await voteBoard()
    const pending = deferred<VoteResult>()
    votesMock.castVote.mockReturnValue(pending.promise)
    fireEvent.click(addButton('Process'))
    await waitFor(() => {
      expect(ownVotes('Process')).toBe('Your votes: 1')
    })

    serverBoard(boardOf({ status: 'discuss' }))
    await refetchBoard()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Discuss' }),
    ).toBeInTheDocument()
    expect(voteButtons()).toHaveLength(0)
    const activeBefore = document.activeElement

    pending.reject(new VotesApiError('cycle_not_voting'))

    expect(
      await screen.findByText(
        'Votes can only be changed during the Vote stage.',
      ),
    ).toBeInTheDocument()
    const statuses = screen
      .getAllByRole('status')
      .filter((element) => element.tagName !== 'OUTPUT')
      .map((element) => element.textContent)
      .filter((text) => text !== '' && text !== null)
    expect(statuses).toEqual(['Stage: Discuss'])
    expect(document.activeElement).toBe(activeBefore)
    expect(voteButtons()).toHaveLength(0)
  })

  it('a cast that succeeds after the stage moved on announces nothing', async () => {
    setup()
    await voteBoard()
    const pending = deferred<VoteResult>()
    votesMock.castVote.mockReturnValue(pending.promise)
    fireEvent.click(addButton('Process'))

    serverBoard(boardOf({ status: 'discuss', votes: [[PROCESS, 1]] }))
    await refetchBoard()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Discuss' }),
    ).toBeInTheDocument()

    pending.resolve(result(PROCESS, 1, 2))
    await act(async () => {
      await pending.promise
    })
    await waitFor(() => {
      expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(2)
    })

    expect(screen.queryByText(/^Vote added/)).not.toBeInTheDocument()
    const statuses = screen
      .getAllByRole('status')
      .filter((element) => element.tagName !== 'OUTPUT')
      .map((element) => element.textContent)
      .filter((text) => text !== '' && text !== null)
    expect(statuses).toEqual(['Stage: Discuss'])
  })

  it('cluster to vote mounts vote mode with the server numbers and only the stage is announced', async () => {
    setup({ board: boardOf({ status: 'cluster' }) })
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Cluster' }),
    ).toBeInTheDocument()

    serverBoard(boardOf())
    await refetchBoard()
    await voteBoard()

    expect(counterText()).toBe('You have 3 votes left.')
    expect(await screen.findByText('Stage: Vote')).toBeInTheDocument()
    expect(statusRegion()).toHaveTextContent('')
  })

  it.each(['collecting', 'reveal', 'cluster', 'discuss', 'closed'] as const)(
    'in %s there is no vote control, count, counter, or notice',
    async (status) => {
      setup({ board: boardOf({ status }), members: asFacilitator })
      await screen.findByRole('heading', { level: 2 })
      await waitFor(() => {
        expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
      })

      expect(voteButtons()).toHaveLength(0)
      expect(
        screen.queryByRole('button', { name: /^(Add|Remove) vote$/ }),
      ).toBeNull()
      expect(screen.queryByText(/Your votes/)).not.toBeInTheDocument()
      expect(screen.queryByText(COUNTER)).not.toBeInTheDocument()
      expect(screen.queryByText(VOTE_TOTALS_HIDDEN)).not.toBeInTheDocument()
      expect(screen.queryByTestId('vote-board')).not.toBeInTheDocument()
      expect(votesMock.castVote).not.toHaveBeenCalled()
      expect(votesMock.removeVote).not.toHaveBeenCalled()
    },
  )
})

describe('roles and privacy', () => {
  it('renders the same vote mode for the facilitator, the owner who is not the facilitator, a member, and while members load or fail', async () => {
    const board = boardOf({ votes: [[PROCESS, 1]] })
    const html: string[] = []
    for (const members of [
      asFacilitator,
      asOwnerNotFacilitator,
      asMember,
      'loading',
      'failed',
    ] as const) {
      const view = setup({ board, members: members as SetupOptions['members'] })
      const element = await voteBoard()
      if (members !== 'loading') {
        await waitFor(() => {
          expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
        })
      }
      expect(voteButtons()).toHaveLength(6)
      html.push(element.outerHTML)
      view.unmount()
      queryClient.clear()
      membersMock.fetchProjectMembers.mockReset()
    }
    expect(new Set(html).size).toBe(1)
  })

  function numbersIn(element: HTMLElement): number[] {
    let text = element.textContent ?? ''
    for (const copy of [VOTE_INTRO, VOTE_TOTALS_HIDDEN, VOTES_WAITING]) {
      text = text.replace(copy, '')
    }
    text = text.replace(VOTES_USED_UP, 'You have 0 votes left.')
    return (text.match(/\d+/g) ?? []).map(Number)
  }

  it.each([
    ['no own votes', [] as Votes],
    ['3 own votes on one cluster', [[PROCESS, 3]] as Votes],
  ])(
    'with %s shows no total, rank, participation, or other number',
    async (_label, votes) => {
      const board = boardOf({ votes })
      setup({ board })
      const element = await voteBoard()

      // The notice itself says totals are hidden; nothing else may.
      const text = (element.textContent ?? '').replace(VOTE_TOTALS_HIDDEN, '')
      for (const pattern of [
        /total/i,
        /rank/i,
        /%/,
        /members voted/i,
        /have voted/i,
        /\bof \d/i,
      ]) {
        expect(text).not.toMatch(pattern)
      }

      // Only card counts, own counts, and the counter.
      const allowed = new Set<number>([board.votesRemaining, 0])
      for (const cluster of board.clusters) {
        allowed.add(cluster.cardIds.length)
      }
      allowed.add(2) // Ungrouped (2)
      for (const vote of board.myVotes) {
        allowed.add(vote.voteCount)
      }
      for (const number of numbersIn(element)) {
        expect(allowed.has(number)).toBe(true)
      }

      expect(
        within(element)
          .getAllByRole('heading', { level: 3 })
          .map((heading) => heading.textContent?.replace(/ \(.*$/, '')),
      ).toEqual([...board.clusters.map((cluster) => cluster.name), 'Ungrouped'])
    },
  )

  /**
   * The vote mode's HTML with the caller's own numbers, the counter, the
   * own-vote border, and the availability that follows from them blanked.
   */
  function normalized(element: HTMLElement): string {
    return element.outerHTML
      .replace(/Your votes: \d/g, 'Your votes: N')
      .replace(COUNTER_HTML, '<p class="text-sm font-medium">COUNTER</p>')
      .replace(`<p class="text-sm">${VOTES_WAITING}</p>`, '')
      .replace(/ border-2 border-primary/g, ' border')
      .replace(/ aria-disabled="true"/g, '')
  }
  const COUNTER_HTML =
    /<p class="text-sm font-medium">You have (\d votes? left|used all 3 votes)\.<\/p>/

  it('a refetch that changes only own votes changes only the numbers, the counter, and the border', async () => {
    setup()
    const element = await voteBoard()
    const before = normalized(element)

    serverBoard(boardOf({ votes: [[PROCESS, 3]] }))
    await refetchBoard()
    await waitFor(() => {
      expect(counterText()).toBe(VOTES_USED_UP)
    })

    expect(normalized(screen.getByTestId('vote-board'))).toBe(before)
  })

  it('marks a cluster with own votes by text and a thicker border, and nothing else', async () => {
    setup()
    await voteBoard()
    const without = section('Process')
    expect(without.className).not.toContain('border-2')
    const htmlWithout = without.outerHTML

    serverBoard(boardOf({ votes: [[PROCESS, 1]] }))
    await refetchBoard()
    await waitFor(() => {
      expect(ownVotes('Process')).toBe('Your votes: 1')
    })
    const withVotes = section('Process')
    expect(withVotes.className).toContain('border-2')
    expect(withVotes.className).toContain('border-primary')
    expect(within(withVotes).getByText('Your votes: 1')).toBeVisible()

    // Remove becomes available because of the vote; otherwise only the
    // text and the class differ.
    expect(
      withVotes.outerHTML
        .replace('Your votes: 1', 'Your votes: 0')
        .replace('border-2 border-primary', 'border'),
    ).toBe(
      htmlWithout.replace(
        /(aria-label="Remove vote from Process") aria-disabled="true"/,
        '$1',
      ),
    )
    // The other clusters stay plain.
    expect(section('Docs').className).not.toContain('border-2')
  })

  it('renders an anonymous card exactly as cluster mode does, with no vote control inside any card', async () => {
    const clusterView = setup({ board: boardOf({ status: 'cluster' }) })
    await screen.findByTestId('cluster-board')
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
    })
    const inCluster = document.querySelector(
      `[data-card-id="${P2.cardId}"]`,
    )?.outerHTML
    clusterView.unmount()
    queryClient.clear()

    setup()
    const element = await voteBoard()
    const card = element.querySelector(`[data-card-id="${P2.cardId}"]`)
    expect(inCluster).toBeDefined()
    expect(card?.outerHTML).toBe(inCluster)

    for (const item of element.querySelectorAll('[data-card-id]')) {
      expect(item.querySelector('button, input, [aria-disabled]')).toBeNull()
      expect(item.outerHTML).not.toMatch(/vote/i)
    }
  })

  it('no announcement, toast, or counter carries card text or an author, and nothing is stored or logged', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const log = vi.spyOn(console, 'log')
    const info = vi.spyOn(console, 'info')
    const error = vi.spyOn(console, 'error')
    setup()
    await voteBoard()

    serverBoard(boardOf({ votes: [[PROCESS, 1]] }))
    votesMock.castVote.mockResolvedValueOnce(result(PROCESS, 1, 2))
    fireEvent.click(addButton('Process'))
    await announced(added('Process', 1, 2))

    votesMock.removeVote.mockRejectedValueOnce(
      new VotesApiError('cluster_not_found'),
    )
    await waitFor(() => {
      expect(removeButton('Process')).not.toHaveAttribute('aria-disabled')
    })
    fireEvent.click(removeButton('Process'))
    const toastText = await screen.findByText('This cluster no longer exists.')

    for (const output of [
      statusRegion().textContent ?? '',
      toastText.textContent ?? '',
      counterText() ?? '',
    ]) {
      for (const word of CARD_WORDS) {
        expect(output).not.toContain(word)
      }
    }
    for (const call of setItem.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/vote|Process/i)
    }
    for (const spy of [log, info, error]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toMatch(/vote|Process/i)
      }
    }
    expect(window.location.href).not.toMatch(/vote/i)
  })
})

describe('edge layouts', () => {
  it('zero clusters: one line, no counter and no vote buttons; Ungrouped still shows', async () => {
    setup({ board: boardOf({ clusters: [] }) })
    const element = await voteBoard()

    expect(
      within(element).getByText('There are no clusters to vote on.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(COUNTER)).not.toBeInTheDocument()
    expect(voteButtons()).toHaveLength(0)
    expect(
      within(element).getByRole('heading', { level: 3, name: 'Ungrouped (5)' }),
    ).toBeInTheDocument()
    expect(within(element).getByText(VOTE_INTRO)).toBeInTheDocument()
  })

  it('a zero-card ai cluster can be voted on like a manual one', async () => {
    setup()
    await voteBoard()
    expect(
      within(section('Tools')).getByText('No cards in this cluster.'),
    ).toBeInTheDocument()
    expect(within(section('Tools')).getByText('AI suggestion')).toBeVisible()

    serverBoard(boardOf({ votes: [[TOOLS, 1]] }))
    votesMock.castVote.mockResolvedValueOnce(result(TOOLS, 1, 2))
    fireEvent.click(addButton('Tools'))
    await announced(added('Tools', 1, 2))
    expect(votesMock.castVote).toHaveBeenCalledWith(CYCLE_ID, TOOLS.clusterId)
  })

  it('shows ungrouped cards under Ungrouped (N) with no vote buttons, and no section when none are ungrouped', async () => {
    const view = setup()
    const element = await voteBoard()
    const ungrouped = within(element)
      .getByRole('heading', { level: 3, name: 'Ungrouped (2)' })
      .closest('section') as HTMLElement
    expect(
      within(ungrouped).getByText('Ungrouped cards cannot receive votes.'),
    ).toBeInTheDocument()
    expect(within(ungrouped).queryAllByRole('button')).toHaveLength(0)
    expect(
      within(ungrouped)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-card-id')),
    ).toEqual([U1.cardId, U2.cardId])
    // Ungrouped comes last.
    expect(element.lastElementChild).toBe(ungrouped)
    view.unmount()
    queryClient.clear()

    setup({ board: boardOf({ cards: [P1, P2, D1] }) })
    await voteBoard()
    expect(screen.queryByText(/^Ungrouped/)).not.toBeInTheDocument()
    expect(
      screen.queryByText('Ungrouped cards cannot receive votes.'),
    ).not.toBeInTheDocument()
  })

  it('with no cards at all the clusters show and can be voted on', async () => {
    const empty = CLUSTERS.map((cluster) => ({ ...cluster, cardIds: [] }))
    setup({ board: boardOf({ cards: [], clusters: empty }) })
    await voteBoard()

    expect(screen.getAllByText('No cards in this cluster.')).toHaveLength(3)
    expect(screen.queryByText(/^Ungrouped/)).not.toBeInTheDocument()

    serverBoard(boardOf({ cards: [], clusters: empty, votes: [[DOCS, 1]] }))
    votesMock.castVote.mockResolvedValueOnce(result(DOCS, 1, 2))
    fireEvent.click(addButton('Docs'))
    await announced(added('Docs', 1, 2))
  })

  it('50 clusters and a 100-character unbroken name with the AI badge', async () => {
    const longName = 'x'.repeat(100)
    const clusters: BoardCluster[] = Array.from({ length: 50 }, (_, index) => ({
      clusterId: `d2000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name:
        index === 0
          ? longName
          : `Topic ${String.fromCharCode(65 + (index % 26))}${index}`,
      source: index === 0 ? 'ai' : 'manual',
      cardIds: [],
    }))
    setup({ board: boardOf({ cards: [], clusters }) })
    const element = await voteBoard()

    expect(within(element).getAllByRole('heading', { level: 3 })).toHaveLength(
      50,
    )
    expect(voteButtons()).toHaveLength(100)
    const heading = section(longName).querySelector('h3')
    const name = heading?.querySelector('[data-cluster-name]')
    expect(name?.className).toContain('[overflow-wrap:anywhere]')
    expect(name?.className).toContain('min-w-0')
    expect(name?.className).not.toContain('break-words')
    expect(within(section(longName)).getByText('AI suggestion')).toBeVisible()
    expect(addButton(longName)).toBeInTheDocument()
  })
})
