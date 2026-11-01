import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import type { CycleStatus } from '../cycles/cycleStatus'
import { queryClient } from '../lib/queryClient'
import type { ProjectMember } from '../projects/membersApi'
import { deferred, mockRestoredSession } from '../test/authMock'
import { boardMock } from '../test/boardMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { ClustersApiError, type ClusterErrorCode } from './clusterErrors'
import type { SavedCluster } from './clustersApi'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/board`
const NOT_FOUND = 'Cycle not found or you do not have access.'
const PLACEHOLDER = 'Grouping cards into clusters is not available yet.'
const INTRO =
  'Group related cards into clusters. Everyone in the project can add, rename and delete clusters until voting starts.'
const LIVE_NOTICE =
  'Live updates are unavailable. The board refreshes every few seconds.'

const cycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'cluster',
}

// Interleaved categories, ids out of alphabetical order: nothing is sorted.
const CARDS: readonly BoardCard[] = [
  {
    cardId: 'f0000000-0000-4000-8000-000000000001',
    category: 'start',
    text: 'Start pairing',
    isAnonymous: false,
    isMine: false,
    authorDisplayName: 'Grace',
  },
  {
    cardId: 'a0000000-0000-4000-8000-000000000002',
    category: 'continue',
    text: 'Continue demos',
    isAnonymous: true,
  },
  {
    cardId: 'c0000000-0000-4000-8000-000000000003',
    category: 'start',
    text: 'Start writing ADRs',
    isAnonymous: true,
  },
  {
    cardId: 'b0000000-0000-4000-8000-000000000004',
    category: 'stop',
    text: 'Stop late merges',
    isAnonymous: false,
    isMine: true,
    authorDisplayName: 'Ada',
  },
  {
    cardId: 'e0000000-0000-4000-8000-000000000005',
    category: 'stop',
    text: 'Stop long meetings',
    isAnonymous: false,
    isMine: false,
    authorDisplayName: null,
  },
]

const PROCESS: BoardCluster = {
  clusterId: 'd1000000-0000-4000-8000-000000000001',
  name: 'Process',
  source: 'manual',
  // card_ids order, not the cards' order.
  cardIds: [CARDS[3].cardId, CARDS[2].cardId],
}

const TOOLS: BoardCluster = {
  clusterId: 'a1000000-0000-4000-8000-000000000002',
  name: 'Tools',
  source: 'ai',
  cardIds: [],
}

function boardOf(
  status: CycleStatus,
  clusters: readonly BoardCluster[] = [PROCESS, TOOLS],
  cards: readonly BoardCard[] = CARDS,
): CycleBoard {
  return {
    cycleId: CYCLE_ID,
    status,
    isRevealed: status !== 'collecting',
    cards,
    clusters,
  }
}

function memberRow(overrides: Partial<ProjectMember>): ProjectMember {
  return {
    userId: 'user-1',
    displayName: 'Dev User',
    role: 'facilitator',
    isOwner: true,
    isMe: true,
    joinedAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  }
}

const asFacilitator = [memberRow({})]
const asMember = [
  memberRow({ role: 'member', isOwner: false }),
  memberRow({ userId: 'user-2', displayName: 'Fac', isMe: false }),
]
const asOwnerOnly = [
  memberRow({ role: 'member', isOwner: true }),
  memberRow({
    userId: 'user-2',
    displayName: 'Fac',
    isMe: false,
    isOwner: false,
  }),
]

interface SetupOptions {
  readonly board?: CycleBoard
  readonly members?: ProjectMember[]
  readonly userId?: string
}

function setup(options: SetupOptions = {}) {
  mockRestoredSession('dev@example.com', options.userId ?? 'user-1')
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  cyclesMock.fetchCycle.mockResolvedValue(cycle)
  boardMock.fetchCycleBoard.mockResolvedValue(
    options.board ?? boardOf('cluster'),
  )
  membersMock.fetchProjectMembers.mockResolvedValue(options.members ?? asMember)
  return renderApp({ initialEntries: [PATH] })
}

function saved(
  cluster: Pick<BoardCluster, 'clusterId' | 'name'>,
): SavedCluster {
  return { clusterId: cluster.clusterId, name: cluster.name, source: 'manual' }
}

async function clusterBoard(): Promise<HTMLElement> {
  return screen.findByTestId('cluster-board')
}

function newForm(): HTMLElement {
  return screen.getByRole('form', { name: 'New cluster' })
}

function newInput(): HTMLElement {
  return within(newForm()).getByRole('textbox', { name: 'Cluster name' })
}

function addButton(): HTMLElement {
  return within(newForm()).getByRole('button', {
    name: /^(Add cluster|Adding…)$/,
  })
}

function typeInto(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name })
  const element = heading.closest('section')
  if (element === null) {
    throw new Error(`no section for ${name}`)
  }
  return element
}

function texts(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelectorAll('p')[1]?.textContent ?? '')
}

function statusText(): string {
  const region = within(screen.getByTestId('cluster-board')).getByRole('status')
  return region.textContent
}

/**
 * React's generated ids (`useId`) come from a counter shared by every render
 * in a test file, so two renders of the same tree get different ids. Number
 * them by first appearance to compare structure.
 */
function normalizeIds(html: string): string {
  const seen = new Map<string, string>()
  return html.replace(/_r_[0-9a-z]+_/g, (id) => {
    const known = seen.get(id)
    if (known !== undefined) {
      return known
    }
    const next = `id-${seen.size}`
    seen.set(id, next)
    return next
  })
}

function emitEvent() {
  act(() => {
    cyclesMock.emitCycleEvent(CYCLE_ID)
  })
}

async function subscribed(): Promise<void> {
  await waitFor(() => {
    expect(
      cyclesMock
        .activeCycleEventsSubscriptions()
        .filter((subscription) => subscription.cycleId === CYCLE_ID),
    ).toHaveLength(1)
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('cluster mode layout', () => {
  it('replaces the placeholder with the intro, the form, Ungrouped, and the clusters in response order', async () => {
    setup()
    const board = await clusterBoard()

    expect(screen.queryByText(PLACEHOLDER)).not.toBeInTheDocument()
    expect(screen.getByText(INTRO)).toBeInTheDocument()
    expect(newInput()).toHaveAttribute('type', 'text')
    expect(newInput()).not.toHaveAttribute('maxlength')
    expect(addButton()).toHaveTextContent('Add cluster')

    // Headings: one h1, one h2, one h3 per section.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
    expect(
      within(board)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Ungrouped (3)', 'Process (2)', 'Tools (0)'])

    const ungrouped = within(section('Ungrouped (3)')).getByRole('list', {
      name: 'Ungrouped cards',
    })
    expect(texts(ungrouped)).toEqual([
      'Start pairing',
      'Continue demos',
      'Stop long meetings',
    ])
    const firstItem = within(ungrouped).getAllByRole('listitem')[0]
    expect(firstItem).toHaveTextContent('StartStart pairingGrace')

    const processList = within(section('Process (2)')).getByRole('list', {
      name: 'Cards in Process',
    })
    expect(texts(processList)).toEqual([
      'Stop late merges',
      'Start writing ADRs',
    ])
    expect(within(processList).getAllByRole('listitem')[0]).toHaveTextContent(
      'StopStop late mergesAda (you)',
    )
    expect(
      within(section('Tools (0)')).getByText('No cards in this cluster yet.'),
    ).toBeInTheDocument()

    for (const name of ['Process', 'Tools']) {
      expect(
        screen.getByRole('button', { name: `Rename cluster ${name}` }),
      ).toHaveTextContent('Rename')
      expect(
        screen.getByRole('button', { name: `Delete cluster ${name}` }),
      ).toHaveTextContent('Delete')
    }
    expect(screen.queryByText('No clusters yet. Add one above.')).toBeNull()
  })

  it('the facilitator, the owner, and an ordinary member see exactly the same cluster controls', async () => {
    const html: string[] = []
    for (const members of [asFacilitator, asOwnerOnly, asMember]) {
      const view = setup({ members })
      await clusterBoard()
      await waitFor(() => {
        expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
      })
      html.push(normalizeIds(screen.getByTestId('cluster-board').outerHTML))
      view.unmount()
      queryClient.clear()
      membersMock.fetchProjectMembers.mockClear()
    }
    expect(html[1]).toBe(html[0])
    expect(html[2]).toBe(html[0])
  })

  it('an anonymous card in a cluster renders as in Ungrouped, identically for two users', async () => {
    const anonymousInCluster: BoardCluster = {
      ...PROCESS,
      cardIds: [CARDS[2].cardId],
    }
    const html: string[] = []
    for (const userId of ['user-1', 'user-2']) {
      const view = setup({
        board: boardOf('cluster', [anonymousInCluster]),
        userId,
      })
      await clusterBoard()
      const clustered = within(
        within(section('Process (1)')).getByRole('list'),
      ).getByRole('listitem')
      const ungroupedAnonymous = within(
        within(section('Ungrouped (4)')).getByRole('list'),
      )
        .getAllByRole('listitem')
        .find((item) => item.textContent.includes('Continue demos'))
      expect(clustered).toHaveTextContent('StartStart writing ADRsAnonymous')
      expect(clustered.textContent).not.toMatch(/you/)
      expect(ungroupedAnonymous?.innerHTML.replace('Continue demos', 'X')).toBe(
        clustered.innerHTML
          .replace('Start writing ADRs', 'X')
          .replace('>Start<', '>Continue<'),
      )
      html.push(clustered.outerHTML)
      view.unmount()
      queryClient.clear()
    }
    expect(html[1]).toBe(html[0])
  })

  it('says when there are no clusters and when every card is in a cluster', async () => {
    const view = setup({ board: boardOf('cluster', []) })
    await clusterBoard()
    expect(
      screen.getByText('No clusters yet. Add one above.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: 'Ungrouped (5)' }),
    ).toBeInTheDocument()
    view.unmount()
    queryClient.clear()

    setup({
      board: boardOf('cluster', [
        { ...PROCESS, cardIds: CARDS.map((card) => card.cardId) },
      ]),
    })
    await clusterBoard()
    expect(screen.getByText('Every card is in a cluster.')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: 'Ungrouped (0)' }),
    ).toBeInTheDocument()
  })

  it('with zero cards says no feedback was submitted', async () => {
    setup({ board: boardOf('cluster', [], []) })
    await clusterBoard()
    expect(
      screen.getByText('No feedback was submitted for this cycle.'),
    ).toBeInTheDocument()
  })

  it.each(['reveal', 'vote', 'discuss', 'closed'] as const)(
    'in %s there is no cluster form, Rename, or Delete, and the card list is unchanged',
    async (status) => {
      setup({ board: boardOf(status) })
      await screen.findByRole('heading', { level: 2 })

      expect(screen.queryByTestId('cluster-board')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('form', { name: 'New cluster' }),
      ).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Rename|Delete/ })).toBeNull()
      expect(screen.queryByText(INTRO)).not.toBeInTheDocument()
      expect(
        screen.getByRole('heading', { level: 3, name: 'Start (2)' }),
      ).toBeInTheDocument()
    },
  )
})

describe('adding a cluster', () => {
  it.each([
    ['', 'Enter a cluster name.'],
    ['  \t ', 'Enter a cluster name.'],
    ['x'.repeat(101), 'Use 100 characters or fewer.'],
    ['  process ', 'A cluster with this name already exists.'],
    ['TOOLS', 'A cluster with this name already exists.'],
    ['ungrouped', 'Choose a name other than Ungrouped.'],
    [' UNGROUPED ', 'Choose a name other than Ungrouped.'],
  ])('%j shows "%s" inline with no request', async (value, message) => {
    setup()
    await clusterBoard()

    typeInto(newInput(), value)
    fireEvent.click(addButton())

    const error = within(newForm()).getByText(message)
    expect(newInput()).toHaveAttribute('aria-invalid', 'true')
    expect(newInput()).toHaveAttribute('aria-describedby', error.id)
    expect(boardMock.createCluster).not.toHaveBeenCalled()

    // Typing clears the message.
    typeInto(newInput(), 'Docs')
    expect(within(newForm()).queryByText(message)).toBeNull()
    expect(newInput()).not.toHaveAttribute('aria-invalid')
  })

  it('accepts exactly 100 characters, trimmed', async () => {
    setup()
    await clusterBoard()
    const name = 'y'.repeat(100)
    boardMock.createCluster.mockResolvedValue(
      saved({ clusterId: 'e1000000-0000-4000-8000-000000000003', name }),
    )

    typeInto(newInput(), `  ${name}  `)
    fireEvent.submit(newForm())

    await waitFor(() => {
      expect(boardMock.createCluster).toHaveBeenCalledWith(CYCLE_ID, name)
    })
  })

  it('sends one request for a double click, shows Adding…, then clears the input, keeps focus, announces, and refetches', async () => {
    setup()
    await clusterBoard()
    const pending = deferred<SavedCluster>()
    boardMock.createCluster.mockReturnValue(pending.promise)
    const docs: BoardCluster = {
      clusterId: 'e1000000-0000-4000-8000-000000000003',
      name: 'Docs',
      source: 'manual',
      cardIds: [],
    }

    typeInto(newInput(), '  Docs ')
    fireEvent.click(addButton())
    fireEvent.click(addButton())
    fireEvent.submit(newForm())

    await waitFor(() => {
      expect(addButton()).toHaveTextContent('Adding…')
    })
    expect(boardMock.createCluster).toHaveBeenCalledTimes(1)
    expect(boardMock.createCluster).toHaveBeenCalledWith(CYCLE_ID, 'Docs')
    expect(addButton()).toBeDisabled()
    // Nothing is optimistic.
    expect(screen.queryByRole('heading', { name: 'Docs (0)' })).toBeNull()

    const before = boardMock.fetchCycleBoard.mock.calls.length
    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [PROCESS, TOOLS, docs]),
    )
    await act(async () => {
      pending.resolve(saved(docs))
      await pending.promise
    })

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Docs (0)' }),
    ).toBeInTheDocument()
    expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(before)
    expect(newInput()).toHaveValue('')
    expect(newInput()).toHaveFocus()
    expect(statusText()).toBe('Added cluster Docs.')
    expect(addButton()).toHaveTextContent('Add cluster')
    expect(addButton()).toBeEnabled()
  })

  it.each<[ClusterErrorCode, string, boolean]>([
    ['cluster_not_found', 'This cluster no longer exists.', true],
    [
      'cycle_not_clustering',
      'Clusters can only be changed during the Cluster stage.',
      false,
    ],
    [
      'invalid_cluster_name',
      'Enter a cluster name of 1 to 100 characters on one line.',
      true,
    ],
    ['cluster_name_taken', 'A cluster with this name already exists.', true],
    ['cluster_limit_reached', 'This cycle already has 50 clusters.', true],
    ['unknown', 'Could not save the cluster.', true],
  ])(
    'a create failing with %s shows "%s" and keeps the draft: %s',
    async (code, message, keepsDraft) => {
      setup()
      await clusterBoard()
      boardMock.createCluster.mockRejectedValue(new ClustersApiError(code))
      const before = boardMock.fetchCycleBoard.mock.calls.length

      typeInto(newInput(), 'Docs')
      fireEvent.click(addButton())

      expect(await screen.findByText(message)).toBeVisible()
      expect(screen.queryByText(code)).toBeNull()
      expect(newInput()).toHaveValue(keepsDraft ? 'Docs' : '')
      await waitFor(() => {
        expect(addButton()).toBeEnabled()
      })
      await waitFor(() => {
        expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(
          before,
        )
      })
    },
  )

  it('not_project_member switches to the not-found state with no toast', async () => {
    setup()
    await clusterBoard()
    boardMock.createCluster.mockRejectedValue(
      new ClustersApiError('not_project_member'),
    )

    typeInto(newInput(), 'Docs')
    fireEvent.click(addButton())

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.queryByTestId('cluster-board')).not.toBeInTheDocument()
    expect(screen.queryByText('Docs')).toBeNull()
  })
})

describe('renaming a cluster', () => {
  async function openRename(name: string): Promise<HTMLElement> {
    fireEvent.click(
      screen.getByRole('button', { name: `Rename cluster ${name}` }),
    )
    const form = screen.getByRole('form', { name: `Rename cluster ${name}` })
    const input = within(form).getByRole('textbox', { name: 'Cluster name' })
    await waitFor(() => {
      expect(input).toHaveFocus()
    })
    return form
  }

  function renameInput(form: HTMLElement): HTMLElement {
    return within(form).getByRole('textbox', { name: 'Cluster name' })
  }

  it('opens prefilled with focus in the input, swapping the heading', async () => {
    setup()
    await clusterBoard()
    const form = await openRename('Process')

    expect(renameInput(form)).toHaveValue('Process')
    expect(
      screen.queryByRole('heading', { level: 3, name: 'Process (2)' }),
    ).toBeNull()
    expect(within(form).getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(within(form).getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it.each(['Escape', 'Cancel'])(
    '%s closes it with no request and returns focus to Rename',
    async (how) => {
      setup()
      await clusterBoard()
      const form = await openRename('Process')
      typeInto(renameInput(form), 'Changed')

      if (how === 'Escape') {
        fireEvent.keyDown(renameInput(form), { key: 'Escape' })
      } else {
        fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
      }

      const rename = await screen.findByRole('button', {
        name: 'Rename cluster Process',
      })
      await waitFor(() => {
        expect(rename).toHaveFocus()
      })
      expect(boardMock.renameCluster).not.toHaveBeenCalled()
      expect(
        screen.getByRole('heading', { level: 3, name: 'Process (2)' }),
      ).toBeInTheDocument()
    },
  )

  it('saving an unchanged name (after trimming) closes it with no request', async () => {
    setup()
    await clusterBoard()
    const form = await openRename('Process')
    typeInto(renameInput(form), '  Process\t')

    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    const rename = await screen.findByRole('button', {
      name: 'Rename cluster Process',
    })
    await waitFor(() => {
      expect(rename).toHaveFocus()
    })
    expect(boardMock.renameCluster).not.toHaveBeenCalled()
  })

  it('validates inline, ignoring its own name but not the others', async () => {
    setup()
    await clusterBoard()
    const form = await openRename('Process')

    typeInto(renameInput(form), 'tools')
    fireEvent.submit(form)
    expect(
      within(form).getByText('A cluster with this name already exists.'),
    ).toBeInTheDocument()
    expect(renameInput(form)).toHaveAttribute('aria-invalid', 'true')

    typeInto(renameInput(form), '')
    fireEvent.submit(form)
    expect(within(form).getByText('Enter a cluster name.')).toBeInTheDocument()
    expect(boardMock.renameCluster).not.toHaveBeenCalled()
  })

  it('a case-only change is a real rename', async () => {
    setup()
    await clusterBoard()
    boardMock.renameCluster.mockResolvedValue(
      saved({ clusterId: PROCESS.clusterId, name: 'PROCESS' }),
    )
    const form = await openRename('Process')
    typeInto(renameInput(form), 'PROCESS')
    fireEvent.submit(form)

    await waitFor(() => {
      expect(boardMock.renameCluster).toHaveBeenCalledWith(
        PROCESS.clusterId,
        'PROCESS',
      )
    })
  })

  it.each(['the call resolves first', 'the refetch lands first'])(
    'a successful save closes the form, returns focus to Rename, and announces, when %s',
    async (order) => {
      setup()
      await clusterBoard()
      await subscribed()
      const pending = deferred<SavedCluster>()
      boardMock.renameCluster.mockReturnValue(pending.promise)
      const renamed = { ...PROCESS, name: 'Process and tools' }
      const form = await openRename('Process')
      typeInto(renameInput(form), ' Process and tools ')

      fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
      fireEvent.click(
        within(form).getByRole('button', { name: /Save|Saving…/ }),
      )
      await waitFor(() => {
        expect(
          within(form).getByRole('button', { name: 'Saving…' }),
        ).toBeDisabled()
      })
      expect(boardMock.renameCluster).toHaveBeenCalledTimes(1)
      expect(boardMock.renameCluster).toHaveBeenCalledWith(
        PROCESS.clusterId,
        'Process and tools',
      )

      if (order === 'the refetch lands first') {
        // Realtime delivers the change before the call answers.
        boardMock.fetchCycleBoard.mockResolvedValue(
          boardOf('cluster', [renamed, TOOLS]),
        )
        emitEvent()
        await waitFor(() => {
          expect(
            screen.getByRole('form', {
              name: 'Rename cluster Process and tools',
            }),
          ).toBeInTheDocument()
        })
        // The draft is untouched by the refetch and the form stays open.
        expect(
          renameInput(
            screen.getByRole('form', {
              name: 'Rename cluster Process and tools',
            }),
          ),
        ).toHaveValue(' Process and tools ')
        await act(async () => {
          pending.resolve(saved(renamed))
          await pending.promise
        })
      } else {
        const refetch = deferred<CycleBoard>()
        boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
        await act(async () => {
          pending.resolve(saved(renamed))
          await pending.promise
        })
        const oldRename = await screen.findByRole('button', {
          name: 'Rename cluster Process',
        })
        await waitFor(() => {
          expect(oldRename).toHaveFocus()
        })
        await act(async () => {
          refetch.resolve(boardOf('cluster', [renamed, TOOLS]))
          await refetch.promise
        })
      }

      const rename = await screen.findByRole('button', {
        name: 'Rename cluster Process and tools',
      })
      await waitFor(() => {
        expect(rename).toHaveFocus()
      })
      expect(screen.queryByRole('form', { name: /^Rename cluster/ })).toBeNull()
      expect(statusText()).toBe('Renamed cluster to Process and tools.')
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: 'Process and tools (2)',
        }),
      ).toBeInTheDocument()
    },
  )

  it.each<[ClusterErrorCode, string]>([
    ['cluster_name_taken', 'A cluster with this name already exists.'],
    [
      'invalid_cluster_name',
      'Enter a cluster name of 1 to 100 characters on one line.',
    ],
    ['unknown', 'Could not save the cluster.'],
  ])(
    'a rename failing with %s shows "%s", keeps the draft and the form, and re-enables Save',
    async (code, message) => {
      setup()
      await clusterBoard()
      boardMock.renameCluster.mockRejectedValue(new ClustersApiError(code))
      const form = await openRename('Process')
      typeInto(renameInput(form), 'Renamed')
      fireEvent.submit(form)

      expect(await screen.findByText(message)).toBeVisible()
      expect(screen.queryByText(code)).toBeNull()
      await waitFor(() => {
        expect(within(form).getByRole('button', { name: 'Save' })).toBeEnabled()
      })
      expect(renameInput(form)).toHaveValue('Renamed')
    },
  )

  it('a rename failing with cycle_not_clustering shows its toast and drops the draft', async () => {
    setup()
    await clusterBoard()
    boardMock.renameCluster.mockRejectedValue(
      new ClustersApiError('cycle_not_clustering'),
    )
    const form = await openRename('Process')
    typeInto(renameInput(form), 'Renamed')
    fireEvent.submit(form)

    expect(
      await screen.findByText(
        'Clusters can only be changed during the Cluster stage.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('form', { name: /^Rename cluster/ })).toBeNull()
    expect(screen.queryByDisplayValue('Renamed')).toBeNull()
  })

  it('a rename failing with cluster_not_found toasts, and the refetch without the cluster closes the form and focuses Cluster name', async () => {
    setup()
    await clusterBoard()
    boardMock.renameCluster.mockRejectedValue(
      new ClustersApiError('cluster_not_found'),
    )
    const form = await openRename('Process')
    typeInto(renameInput(form), 'Renamed')
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [TOOLS]))
    fireEvent.submit(form)

    expect(
      await screen.findByText('This cluster no longer exists.'),
    ).toBeVisible()
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: /^Rename cluster/ })).toBeNull()
    })
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })
  })

  it('a refetch that renames the cluster being edited leaves the draft untouched', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const form = await openRename('Process')
    typeInto(renameInput(form), 'My draft')

    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [{ ...PROCESS, name: 'Someone else' }, TOOLS]),
    )
    emitEvent()

    const renamedForm = await screen.findByRole('form', {
      name: 'Rename cluster Someone else',
    })
    expect(renameInput(renamedForm)).toHaveValue('My draft')
    expect(renameInput(renamedForm)).toHaveFocus()
  })

  it('a refetch where the cluster is gone closes the form and moves focus to Cluster name', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const form = await openRename('Process')
    typeInto(renameInput(form), 'My draft')
    typeInto(newInput(), 'New draft')
    fireEvent.focus(renameInput(form))

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [TOOLS]))
    emitEvent()

    await waitFor(() => {
      expect(screen.queryByRole('form', { name: /^Rename cluster/ })).toBeNull()
    })
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })
    // Another member's edit never overwrites the new-cluster draft.
    expect(newInput()).toHaveValue('New draft')
    expect(boardMock.renameCluster).not.toHaveBeenCalled()
  })
})

describe('deleting a cluster', () => {
  async function openDelete(name: string): Promise<HTMLElement> {
    fireEvent.click(
      screen.getByRole('button', { name: `Delete cluster ${name}` }),
    )
    const group = screen.getByRole('group', { name: `Delete cluster ${name}` })
    await waitFor(() => {
      expect(
        within(group).getByRole('button', { name: 'Cancel' }),
      ).toHaveFocus()
    })
    return group
  }

  it.each([
    [
      PROCESS,
      'Delete the cluster "Process"? Its 2 cards go back to Ungrouped.',
    ],
    [TOOLS, 'Delete the cluster "Tools"? It has no cards.'],
    [
      { ...PROCESS, cardIds: [CARDS[3].cardId] },
      'Delete the cluster "Process"? Its 1 card goes back to Ungrouped.',
    ],
  ])(
    'the confirmation for %o reads "%s", with focus on Cancel',
    async (cluster, copy) => {
      setup({
        board: boardOf(
          'cluster',
          cluster.clusterId === TOOLS.clusterId
            ? [PROCESS, cluster]
            : [cluster, TOOLS],
        ),
      })
      await clusterBoard()
      const group = await openDelete(cluster.name)

      expect(within(group).getByText(copy)).toBeInTheDocument()
      expect(
        within(group).getByRole('button', { name: 'Delete cluster' }),
      ).toBeEnabled()
    },
  )

  it.each(['Escape', 'Cancel'])(
    '%s closes it with no request and returns focus to Delete',
    async (how) => {
      setup()
      await clusterBoard()
      const group = await openDelete('Process')

      if (how === 'Escape') {
        fireEvent.keyDown(
          within(group).getByRole('button', { name: 'Cancel' }),
          {
            key: 'Escape',
          },
        )
      } else {
        fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))
      }

      const trigger = await screen.findByRole('button', {
        name: 'Delete cluster Process',
      })
      await waitFor(() => {
        expect(trigger).toHaveFocus()
      })
      expect(boardMock.deleteCluster).not.toHaveBeenCalled()
    },
  )

  it.each(['the call resolves first', 'the refetch lands first'])(
    'confirming calls deleteCluster once, moves focus to Cluster name, and announces, when %s',
    async (order) => {
      setup()
      await clusterBoard()
      await subscribed()
      const pending = deferred<undefined>()
      boardMock.deleteCluster.mockReturnValue(pending.promise)
      const group = await openDelete('Process')
      const confirm = within(group).getByRole('button', {
        name: 'Delete cluster',
      })

      fireEvent.click(confirm)
      fireEvent.click(confirm)
      await waitFor(() => {
        expect(
          within(group).getByRole('button', { name: 'Deleting…' }),
        ).toBeDisabled()
      })
      expect(boardMock.deleteCluster).toHaveBeenCalledTimes(1)
      expect(boardMock.deleteCluster).toHaveBeenCalledWith(PROCESS.clusterId)

      if (order === 'the refetch lands first') {
        boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [TOOLS]))
        emitEvent()
        await waitFor(() => {
          expect(
            screen.queryByRole('group', { name: /^Delete cluster/ }),
          ).toBeNull()
        })
        await act(async () => {
          pending.resolve(undefined)
          await pending.promise
        })
      } else {
        const refetch = deferred<CycleBoard>()
        boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
        await act(async () => {
          pending.resolve(undefined)
          await pending.promise
        })
        await waitFor(() => {
          expect(newInput()).toHaveFocus()
        })
        await act(async () => {
          refetch.resolve(boardOf('cluster', [TOOLS]))
          await refetch.promise
        })
      }

      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { level: 3, name: 'Process (2)' }),
        ).toBeNull()
      })
      await waitFor(() => {
        expect(newInput()).toHaveFocus()
      })
      expect(statusText()).toBe('Deleted cluster Process.')
      expect(
        screen.getByRole('heading', { level: 3, name: 'Ungrouped (5)' }),
      ).toBeInTheDocument()
    },
  )

  it.each<[ClusterErrorCode, string]>([
    ['unknown', 'Could not delete the cluster.'],
    ['cluster_not_found', 'This cluster no longer exists.'],
  ])(
    'a delete failing with %s shows "%s" and re-enables the confirmation',
    async (code, message) => {
      setup()
      await clusterBoard()
      boardMock.deleteCluster.mockRejectedValue(new ClustersApiError(code))
      const group = await openDelete('Process')
      fireEvent.click(
        within(group).getByRole('button', { name: 'Delete cluster' }),
      )

      expect(await screen.findByText(message)).toBeVisible()
      await waitFor(() => {
        expect(
          within(group).getByRole('button', { name: 'Delete cluster' }),
        ).toBeEnabled()
      })
    },
  )

  it('a delete failing with not_project_member switches to the not-found state', async () => {
    setup()
    await clusterBoard()
    boardMock.deleteCluster.mockRejectedValue(
      new ClustersApiError('not_project_member'),
    )
    const group = await openDelete('Process')
    fireEvent.click(
      within(group).getByRole('button', { name: 'Delete cluster' }),
    )

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
  })
})

describe('stage changes and live updates', () => {
  it('a stage change to vote while a rename form is open removes every cluster form and control and renders Vote', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    fireEvent.click(
      screen.getByRole('button', { name: 'Rename cluster Process' }),
    )
    typeInto(
      within(
        screen.getByRole('form', { name: 'Rename cluster Process' }),
      ).getByRole('textbox'),
      'Draft',
    )

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
    emitEvent()

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('cluster-board')).toBeNull()
    expect(screen.queryByRole('form')).toBeNull()
    expect(
      screen.queryByRole('button', { name: /Rename|Delete|Add cluster/ }),
    ).toBeNull()
    expect(screen.queryByDisplayValue('Draft')).toBeNull()
  })

  it('a create that loses the race to the stage change shows its toast', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const pending = deferred<SavedCluster>()
    boardMock.createCluster.mockReturnValue(pending.promise)
    typeInto(newInput(), 'Late')
    fireEvent.click(addButton())

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
    emitEvent()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()

    await act(async () => {
      pending.reject(new ClustersApiError('cycle_not_clustering'))
      await pending.promise.catch(() => undefined)
    })
    expect(
      await screen.findByText(
        'Clusters can only be changed during the Cluster stage.',
      ),
    ).toBeVisible()
  })

  it('a clusters_changed event refetches the board and renders the new clusters without polling while live', async () => {
    setup({ board: boardOf('cluster', []) })
    await clusterBoard()
    await subscribed()
    act(() => {
      cyclesMock.emitCycleEventsStatus(CYCLE_ID, 'SUBSCRIBED')
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [PROCESS]))
    emitEvent()

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Process (2)' }),
    ).toBeInTheDocument()
    expect(
      invalidate.mock.calls.map(([filters]) => filters?.queryKey),
    ).toContainEqual(['cycle-board', 'user-1', CYCLE_ID])
    expect(screen.queryByText(LIVE_NOTICE)).toBeNull()

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    const before = boardMock.fetchCycleBoard.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(boardMock.fetchCycleBoard.mock.calls.length).toBe(before)
  })
})

describe('"Start voting" confirmation', () => {
  it.each<[string, readonly BoardCluster[], string]>([
    [
      'two clusters and three ungrouped cards',
      [PROCESS, TOOLS],
      'There are 2 clusters and 3 ungrouped cards. Ungrouped cards cannot receive votes.',
    ],
    [
      'one cluster and one ungrouped card',
      [{ ...PROCESS, cardIds: CARDS.slice(1).map((card) => card.cardId) }],
      'There is 1 cluster and 1 ungrouped card. Ungrouped cards cannot receive votes.',
    ],
    [
      'no clusters',
      [],
      'There are no clusters yet, so there is nothing to vote on.',
    ],
  ])(
    'with %s shows the counts before its own copy',
    async (_label, clusters, note) => {
      setup({ board: boardOf('cluster', clusters), members: asFacilitator })
      fireEvent.click(
        await screen.findByRole('button', { name: 'Start voting' }),
      )

      const group = screen.getByRole('group', { name: 'Start voting' })
      const paragraphs = Array.from(group.querySelectorAll('p')).map(
        (p) => p.textContent,
      )
      expect(paragraphs).toEqual([
        note,
        'Move everyone to the Vote stage? Clusters cannot be changed once voting starts, and you cannot go back to Cluster.',
      ])
      // It does not block the advance.
      expect(
        within(group).getByRole('button', { name: 'Start voting' }),
      ).toBeEnabled()
    },
  )
})
