import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
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
import { renderApp } from '../test/renderApp'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { ClustersApiError, type ClusterErrorCode } from './clusterErrors'
import type { SavedCluster } from './clustersApi'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/board`
const NOT_FOUND = 'Cycle not found or you do not have access.'

const cycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'cluster',
}

const LONG_TEXT =
  'Stop scheduling long meetings on Friday afternoons without an agenda'

const U1: BoardCard = {
  cardId: 'f0000000-0000-4000-8000-000000000001',
  category: 'start',
  text: 'Start pairing',
  isAnonymous: false,
  isMine: false,
  authorDisplayName: 'Grace',
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
const P3: BoardCard = {
  cardId: 'e0000000-0000-4000-8000-000000000005',
  category: 'stop',
  text: LONG_TEXT,
  isAnonymous: false,
  isMine: false,
  authorDisplayName: null,
}
const T1: BoardCard = {
  cardId: 'a0000000-0000-4000-8000-000000000006',
  category: 'continue',
  text: 'Continue demos',
  isAnonymous: true,
}
const CARDS = [U1, P1, P2, P3, T1]

const PROCESS: BoardCluster = {
  clusterId: 'd1000000-0000-4000-8000-000000000001',
  name: 'Process',
  source: 'manual',
  cardIds: [P1.cardId, P2.cardId, P3.cardId],
}
const TOOLS: BoardCluster = {
  clusterId: 'a1000000-0000-4000-8000-000000000002',
  name: 'Tools',
  source: 'ai',
  cardIds: [T1.cardId],
}
const DOCS: BoardCluster = {
  clusterId: 'b1000000-0000-4000-8000-000000000003',
  name: 'Docs',
  source: 'manual',
  cardIds: [],
}
const NEW_ID = 'e1000000-0000-4000-8000-000000000009'

function boardOf(
  status: CycleStatus,
  clusters: readonly BoardCluster[] = [PROCESS, TOOLS, DOCS],
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

function withCards(
  cluster: BoardCluster,
  cards: readonly BoardCard[],
): BoardCluster {
  return { ...cluster, cardIds: cards.map((card) => card.cardId) }
}

function saved(cluster: BoardCluster, name = cluster.name): SavedCluster {
  return { clusterId: cluster.clusterId, name, source: 'manual' }
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

interface SetupOptions {
  readonly board?: CycleBoard
  readonly members?: ProjectMember[]
  readonly userId?: string
  readonly pointer?: 'fine' | 'coarse'
}

function mockPointer(pointer: 'fine' | 'coarse') {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string): MediaQueryList => ({
      matches: query === '(pointer: fine)' && pointer === 'fine',
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  )
}

function setup(options: SetupOptions = {}) {
  mockPointer(options.pointer ?? 'coarse')
  mockRestoredSession('dev@example.com', options.userId ?? 'user-1')
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  cyclesMock.fetchCycle.mockResolvedValue(cycle)
  boardMock.fetchCycleBoard.mockResolvedValue(
    options.board ?? boardOf('cluster'),
  )
  membersMock.fetchProjectMembers.mockResolvedValue(
    options.members ?? [memberRow({})],
  )
  return renderApp({ initialEntries: [PATH] })
}

async function clusterBoard(): Promise<HTMLElement> {
  return screen.findByTestId('cluster-board')
}

function section(name: RegExp): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name })
  const element = heading.closest('section')
  if (element === null) {
    throw new Error(`no section for ${String(name)}`)
  }
  return element
}

function statusText(): string {
  return within(screen.getByTestId('cluster-board')).getByRole('status')
    .textContent
}

function newInput(): HTMLElement {
  return within(screen.getByRole('form', { name: 'New cluster' })).getByRole(
    'textbox',
    { name: 'Cluster name' },
  )
}

function button(name: string): HTMLElement {
  return screen.getByRole('button', { name })
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

/** Another member's change: the next board, delivered through Realtime. */
async function refetchWith(board: CycleBoard): Promise<void> {
  boardMock.fetchCycleBoard.mockResolvedValue(board)
  const before = boardMock.fetchCycleBoard.mock.calls.length
  emitEvent()
  await waitFor(() => {
    expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(before)
  })
  // Let the refetched board render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function mergeGroup(name = 'Process'): HTMLElement {
  return screen.getByRole('group', { name: `Merge cluster ${name}` })
}

function mergeSelect(name = 'Process'): HTMLSelectElement {
  const select = within(mergeGroup(name)).getByRole('combobox', {
    name: 'Merge into',
  })
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error('expected a select')
  }
  return select
}

function optionLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.textContent)
}

async function openMerge(name = 'Process'): Promise<HTMLSelectElement> {
  fireEvent.click(button(`Merge cluster ${name}`))
  const select = mergeSelect(name)
  await waitFor(() => {
    expect(select).toHaveFocus()
  })
  return select
}

function splitForm(name = 'Process'): HTMLElement {
  return screen.getByRole('form', { name: `Split cluster ${name}` })
}

function splitInput(name = 'Process'): HTMLInputElement {
  const input = within(splitForm(name)).getByRole('textbox', {
    name: 'New cluster name',
  })
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('expected an input')
  }
  return input
}

function cut(card: BoardCard): string {
  const characters = [...card.text]
  return characters.length > 40
    ? `${characters.slice(0, 40).join('')}…`
    : card.text
}

function checkbox(card: BoardCard): HTMLInputElement {
  const box = screen.getByRole('checkbox', {
    name: `Select card: ${cut(card)}`,
  })
  if (!(box instanceof HTMLInputElement)) {
    throw new Error('expected a checkbox')
  }
  return box
}

async function openSplit(name = 'Process'): Promise<void> {
  fireEvent.click(button(`Split cluster ${name}`))
  await waitFor(() => {
    expect(screen.getAllByRole('checkbox')[0]).toHaveFocus()
  })
}

function moveButtons(): HTMLElement[] {
  return screen.getAllByRole('button', { name: /^Move card: / })
}

describe('the Merge control', () => {
  it('is not rendered with one cluster', async () => {
    setup({ board: boardOf('cluster', [PROCESS]) })
    await clusterBoard()
    expect(button('Rename cluster Process')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Merge/ })).toBeNull()
  })

  it('with three clusters each has one; its select lists the other two in board order with counts, the first preselected and focused', async () => {
    setup()
    await clusterBoard()
    for (const name of ['Process', 'Tools', 'Docs']) {
      expect(button(`Merge cluster ${name}`)).toHaveTextContent('Merge')
    }

    const select = await openMerge('Process')
    expect(optionLabels(select)).toEqual(['Tools (1 card)', 'Docs (0 cards)'])
    expect(select.value).toBe(TOOLS.clusterId)
    expect(mergeGroup()).toHaveAttribute('role', 'group')

    fireEvent.click(
      within(mergeGroup()).getByRole('button', { name: 'Cancel' }),
    )
    const tools = await openMerge('Tools')
    expect(optionLabels(tools)).toEqual(['Process (3 cards)', 'Docs (0 cards)'])
  })

  it('the sentence follows the select, and an empty source has its own sentence', async () => {
    setup()
    await clusterBoard()
    const select = await openMerge('Process')
    expect(
      within(mergeGroup()).getByText(
        'Move the 3 cards of "Process" to the end of "Tools" and remove "Process"? "Tools" will have 4 cards.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(select, { target: { value: DOCS.clusterId } })
    expect(
      within(mergeGroup()).getByText(
        'Move the 3 cards of "Process" to the end of "Docs" and remove "Process"? "Docs" will have 3 cards.',
      ),
    ).toBeInTheDocument()

    await openMerge('Docs')
    expect(
      within(mergeGroup('Docs')).getByText(
        '"Docs" has no cards. Merging removes it.',
      ),
    ).toBeInTheDocument()
  })

  it('merges once, shows Merging…, and after the refetch announces and focuses the target Rename', async () => {
    setup()
    await clusterBoard()
    const pending = deferred<SavedCluster>()
    boardMock.mergeClusters.mockReturnValue(pending.promise)

    await openMerge('Process')
    const confirm = within(mergeGroup()).getByRole('button', {
      name: 'Merge clusters',
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(boardMock.mergeClusters).toHaveBeenCalledTimes(1)
    })
    expect(boardMock.mergeClusters).toHaveBeenCalledWith(
      PROCESS.clusterId,
      TOOLS.clusterId,
    )
    await waitFor(() => {
      expect(confirm).toHaveTextContent('Merging…')
    })
    expect(confirm).toBeDisabled()

    // The refetch after the merge is slow: nothing is announced until it is in.
    const refetch = deferred<CycleBoard | null>()
    boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
    await act(async () => {
      pending.resolve(saved(TOOLS))
      await pending.promise
    })
    expect(statusText()).toBe('')
    await act(async () => {
      refetch.resolve(
        boardOf('cluster', [withCards(TOOLS, [T1, P1, P2, P3]), DOCS]),
      )
      await refetch.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe('Merged cluster Process into Tools.')
    })
    await waitFor(() => {
      expect(button('Rename cluster Tools')).toHaveFocus()
    })
    expect(screen.queryByRole('group', { name: /^Merge cluster/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^Process/ })).toBeNull()
  })

  it('when the Realtime refetch lands before the merge resolves, it still announces the RPC name and focuses the target', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const pending = deferred<SavedCluster>()
    boardMock.mergeClusters.mockReturnValue(pending.promise)
    await openMerge('Process')
    fireEvent.click(
      within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
    )

    // The source is already gone from this board; the form waits.
    const merged = boardOf('cluster', [
      { ...withCards(TOOLS, [T1, P1, P2, P3]), name: 'Toolbox' },
      DOCS,
    ])
    await refetchWith(merged)
    expect(screen.queryByRole('heading', { name: /^Process/ })).toBeNull()
    expect(newInput()).not.toHaveFocus()

    await act(async () => {
      pending.resolve(saved(TOOLS, 'Toolbox'))
      await pending.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe('Merged cluster Process into Toolbox.')
    })
    await waitFor(() => {
      expect(button('Rename cluster Toolbox')).toHaveFocus()
    })
  })

  it('Escape and Cancel close it with no request and focus Merge; opening Rename elsewhere closes it', async () => {
    setup()
    await clusterBoard()
    const select = await openMerge('Process')
    fireEvent.keyDown(select, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: /^Merge cluster/ })).toBeNull()
    await waitFor(() => {
      expect(button('Merge cluster Process')).toHaveFocus()
    })

    await openMerge('Process')
    fireEvent.click(
      within(mergeGroup()).getByRole('button', { name: 'Cancel' }),
    )
    await waitFor(() => {
      expect(button('Merge cluster Process')).toHaveFocus()
    })

    await openMerge('Process')
    fireEvent.click(button('Rename cluster Tools'))
    expect(screen.queryByRole('group', { name: /^Merge cluster/ })).toBeNull()
    expect(
      screen.getByRole('form', { name: 'Rename cluster Tools' }),
    ).toBeInTheDocument()
    expect(boardMock.mergeClusters).not.toHaveBeenCalled()
  })

  it('follows renames and removals of the targets, and closes when nothing is left to merge into or the source goes', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const select = await openMerge('Process')
    fireEvent.change(select, { target: { value: DOCS.clusterId } })

    await refetchWith(
      boardOf('cluster', [PROCESS, TOOLS, { ...DOCS, name: 'Writing' }]),
    )
    expect(optionLabels(mergeSelect())).toEqual([
      'Tools (1 card)',
      'Writing (0 cards)',
    ])
    expect(mergeSelect().value).toBe(DOCS.clusterId)
    expect(
      within(mergeGroup()).queryByText(
        'The cluster you chose no longer exists. Choose another.',
      ),
    ).toBeNull()

    await refetchWith(boardOf('cluster', [PROCESS, TOOLS]))
    expect(optionLabels(mergeSelect())).toEqual(['Tools (1 card)'])
    expect(mergeSelect().value).toBe(TOOLS.clusterId)
    expect(
      within(mergeGroup()).getByText(
        'The cluster you chose no longer exists. Choose another.',
      ),
    ).toBeInTheDocument()
    expect(
      within(mergeGroup()).getByText(
        'Move the 3 cards of "Process" to the end of "Tools" and remove "Process"? "Tools" will have 4 cards.',
      ),
    ).toBeInTheDocument()

    await refetchWith(boardOf('cluster', [PROCESS]))
    expect(screen.queryByRole('group', { name: /^Merge cluster/ })).toBeNull()
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })

    await refetchWith(boardOf('cluster', [PROCESS, TOOLS]))
    await openMerge('Process')
    await refetchWith(boardOf('cluster', [TOOLS]))
    expect(screen.queryByRole('group', { name: /^Merge cluster/ })).toBeNull()
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })
    expect(boardMock.mergeClusters).not.toHaveBeenCalled()
  })
})

describe('the Split control', () => {
  it('needs two cards; it shows unchecked boxes for that cluster only, focus on the first, the name input and the count', async () => {
    setup()
    await clusterBoard()
    expect(
      screen.queryByRole('button', { name: 'Split cluster Tools' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Split cluster Docs' }),
    ).toBeNull()
    expect(button('Split cluster Process')).toHaveTextContent('Split')

    await openSplit('Process')
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(3)
    expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual([
      'Select card: Stop late merges',
      'Select card: Start writing ADRs',
      `Select card: ${LONG_TEXT.slice(0, 40)}…`,
    ])
    for (const box of boxes) {
      expect(box).not.toBeChecked()
      expect(section(/^Process/)).toContainElement(box)
    }
    expect(boxes[0]).toHaveFocus()
    expect(splitInput()).toHaveValue('')
    expect(within(splitForm()).getByText('0 of 3 cards selected')).toBeVisible()
  })

  it('works by keyboard: the boxes come in card order, Space toggles and the count follows, then the input and buttons; Enter submits', async () => {
    setup()
    await clusterBoard()
    await openSplit('Process')

    const focusables = Array.from(
      section(/^Process/).querySelectorAll<HTMLElement>(
        'input, button, select, [tabindex]',
      ),
    ).filter(
      (element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'),
    )
    const order = focusables.map(
      (element) =>
        element.getAttribute('aria-label') ?? element.textContent ?? '',
    )
    const boxes = order.filter((label) => label.startsWith('Select card: '))
    expect(boxes).toEqual([
      'Select card: Stop late merges',
      'Select card: Start writing ADRs',
      `Select card: ${LONG_TEXT.slice(0, 40)}…`,
    ])
    const lastBox = order.indexOf(boxes[2])
    const nameIndex = focusables.indexOf(splitInput())
    expect(nameIndex).toBeGreaterThan(lastBox)
    expect(order.slice(nameIndex + 1)).toEqual([
      'Cancel',
      'Split into new cluster',
    ])
    expect(
      section(/^Process/).querySelector(
        '[tabindex]:not([tabindex="-1"]):not([tabindex="0"])',
      ),
    ).toBeNull()

    // Space on a native checkbox is a click.
    fireEvent.keyDown(checkbox(P2), { key: ' ' })
    fireEvent.click(checkbox(P2))
    expect(checkbox(P2)).toBeChecked()
    expect(within(splitForm()).getByText('1 of 3 cards selected')).toBeVisible()

    boardMock.splitCluster.mockReturnValue(new Promise(() => undefined))
    fireEvent.change(splitInput(), { target: { value: 'Docs two' } })
    fireEvent.submit(splitForm())
    await waitFor(() => {
      expect(boardMock.splitCluster).toHaveBeenCalledWith(
        PROCESS.clusterId,
        [P2.cardId],
        'Docs two',
      )
    })
  })

  it('shows each client message inline and sends nothing', async () => {
    setup()
    await clusterBoard()
    await openSplit('Process')
    const submit = within(splitForm()).getByRole('button', {
      name: 'Split into new cluster',
    })

    const expectMessage = (text: string, nameInvalid: boolean) => {
      const alert = within(splitForm()).getByRole('alert')
      expect(alert).toHaveTextContent(text)
      expect(submit.getAttribute('aria-describedby')).toContain(alert.id)
      expect(submit).not.toBeDisabled()
      if (nameInvalid) {
        expect(splitInput()).toHaveAttribute('aria-invalid', 'true')
        expect(splitInput()).toHaveAttribute('aria-describedby', alert.id)
      } else {
        expect(splitInput()).not.toHaveAttribute('aria-invalid')
      }
    }

    fireEvent.change(splitInput(), { target: { value: 'New' } })
    fireEvent.click(submit)
    expectMessage('Select at least one card to move.', false)

    for (const card of [P1, P2, P3]) {
      fireEvent.click(checkbox(card))
    }
    fireEvent.click(submit)
    expectMessage(
      'Leave at least one card in Process. To rename the cluster, use Rename.',
      false,
    )
    fireEvent.click(checkbox(P3))

    for (const [name, message] of [
      ['   ', 'Enter a cluster name.'],
      ['x'.repeat(101), 'Use 100 characters or fewer.'],
      ['tools', 'A cluster with this name already exists.'],
      ['PROCESS', 'A cluster with this name already exists.'],
      ['Ungrouped', 'Choose a name other than Ungrouped.'],
    ] as const) {
      fireEvent.change(splitInput(), { target: { value: name } })
      fireEvent.submit(splitForm())
      expectMessage(message, true)
    }
    expect(boardMock.splitCluster).not.toHaveBeenCalled()
  })

  it('with 50 clusters on the board it says so inline', async () => {
    const fillers = Array.from(
      { length: 49 },
      (_unused, index): BoardCluster => ({
        clusterId: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: `Filler ${String(index)}`,
        source: 'manual',
        cardIds: [],
      }),
    )
    setup({ board: boardOf('cluster', [PROCESS, ...fillers]) })
    await clusterBoard()
    await openSplit('Process')
    fireEvent.click(checkbox(P1))
    fireEvent.change(splitInput(), { target: { value: 'New' } })
    fireEvent.submit(splitForm())
    expect(within(splitForm()).getByRole('alert')).toHaveTextContent(
      'This cycle already has 50 clusters.',
    )
    expect(boardMock.splitCluster).not.toHaveBeenCalled()
  })

  it('splits once in the cluster order, shows Splitting…, and after the refetch announces and focuses the new Rename', async () => {
    setup()
    await clusterBoard()
    const pending = deferred<SavedCluster>()
    boardMock.splitCluster.mockReturnValue(pending.promise)

    await openSplit('Process')
    fireEvent.click(checkbox(P3))
    fireEvent.click(checkbox(P1))
    expect(within(splitForm()).getByText('2 of 3 cards selected')).toBeVisible()
    fireEvent.change(splitInput(), { target: { value: '  Meetings ' } })
    fireEvent.submit(splitForm())
    fireEvent.submit(splitForm())
    await waitFor(() => {
      expect(boardMock.splitCluster).toHaveBeenCalledTimes(1)
    })
    expect(boardMock.splitCluster).toHaveBeenCalledWith(
      PROCESS.clusterId,
      [P1.cardId, P3.cardId],
      'Meetings',
    )
    const submit = within(splitForm()).getByRole('button', {
      name: 'Splitting…',
    })
    expect(submit).toBeDisabled()

    const refetch = deferred<CycleBoard | null>()
    boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
    await act(async () => {
      pending.resolve({ clusterId: NEW_ID, name: 'Meetings', source: 'manual' })
      await pending.promise
    })
    expect(statusText()).toBe('')
    const meetings: BoardCluster = {
      clusterId: NEW_ID,
      name: 'Meetings',
      source: 'manual',
      cardIds: [P1.cardId, P3.cardId],
    }
    await act(async () => {
      refetch.resolve(
        boardOf('cluster', [withCards(PROCESS, [P2]), TOOLS, DOCS, meetings]),
      )
      await refetch.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe('Split 2 cards into Meetings.')
    })
    await waitFor(() => {
      expect(button('Rename cluster Meetings')).toHaveFocus()
    })
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('form', { name: /^Split cluster/ })).toBeNull()
  })

  it('announces one card in the singular, also when the Realtime refetch comes first', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const pending = deferred<SavedCluster>()
    boardMock.splitCluster.mockReturnValue(pending.promise)

    await openSplit('Process')
    fireEvent.click(checkbox(P2))
    fireEvent.change(splitInput(), { target: { value: 'ADRs' } })
    fireEvent.submit(splitForm())

    const adrs: BoardCluster = {
      clusterId: NEW_ID,
      name: 'ADRs',
      source: 'manual',
      cardIds: [P2.cardId],
    }
    await refetchWith(
      boardOf('cluster', [withCards(PROCESS, [P1, P3]), TOOLS, DOCS, adrs]),
    )
    // The form waits for its own result.
    expect(splitForm()).toBeInTheDocument()

    await act(async () => {
      pending.resolve({ clusterId: NEW_ID, name: 'ADRs', source: 'manual' })
      await pending.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe('Split 1 card into ADRs.')
    })
    await waitFor(() => {
      expect(button('Rename cluster ADRs')).toHaveFocus()
    })
  })

  it('follows other members: a card that leaves drops out, one that arrives is unchecked, the typed name stays; below two cards or gone, it closes', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    await openSplit('Process')
    fireEvent.click(checkbox(P1))
    fireEvent.click(checkbox(P3))
    fireEvent.change(splitInput(), { target: { value: 'Draft name' } })
    expect(within(splitForm()).getByText('2 of 3 cards selected')).toBeVisible()

    await refetchWith(
      boardOf('cluster', [
        withCards(PROCESS, [P1, P2]),
        withCards(TOOLS, [T1, P3]),
        DOCS,
      ]),
    )
    expect(within(splitForm()).getByText('1 of 2 cards selected')).toBeVisible()
    expect(checkbox(P1)).toBeChecked()
    expect(checkbox(P2)).not.toBeChecked()
    expect(splitInput()).toHaveValue('Draft name')

    await refetchWith(
      boardOf('cluster', [withCards(PROCESS, [P1, P2, U1]), TOOLS, DOCS]),
    )
    expect(checkbox(U1)).not.toBeChecked()
    expect(within(splitForm()).getByText('1 of 3 cards selected')).toBeVisible()
    expect(splitInput()).toHaveValue('Draft name')

    await refetchWith(
      boardOf('cluster', [withCards(PROCESS, [P1]), TOOLS, DOCS]),
    )
    expect(screen.queryByRole('form', { name: /^Split cluster/ })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    await waitFor(() => {
      expect(button('Rename cluster Process')).toHaveFocus()
    })

    await refetchWith(boardOf('cluster'))
    await openSplit('Process')
    await refetchWith(boardOf('cluster', [TOOLS, DOCS]))
    expect(screen.queryByRole('form', { name: /^Split cluster/ })).toBeNull()
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })
    expect(boardMock.splitCluster).not.toHaveBeenCalled()
  })

  it('Escape on a box and Cancel close it with no request and focus Split', async () => {
    setup()
    await clusterBoard()
    await openSplit('Process')
    fireEvent.keyDown(checkbox(P1), { key: 'Escape' })
    expect(screen.queryByRole('checkbox')).toBeNull()
    await waitFor(() => {
      expect(button('Split cluster Process')).toHaveFocus()
    })
    await openSplit('Process')
    fireEvent.click(checkbox(P1))
    fireEvent.click(within(splitForm()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(button('Split cluster Process')).toHaveFocus()
    })
    // The selection lived only in the form.
    await openSplit('Process')
    expect(checkbox(P1)).not.toBeChecked()
    expect(boardMock.splitCluster).not.toHaveBeenCalled()
  })

  it('an anonymous card renders identical checkbox DOM for two members and its author; every role sees the same controls', async () => {
    const html: string[] = []
    const views: [string, ProjectMember[]][] = [
      ['user-1', [memberRow({ role: 'facilitator', isOwner: true })]],
      ['user-2', [memberRow({ userId: 'user-2', isOwner: true })]],
      ['user-3', [memberRow({ userId: 'user-3' })]],
    ]
    for (const [userId, members] of views) {
      const view = setup({ userId, members })
      await clusterBoard()
      await waitFor(() => {
        expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
      })
      const controls = section(/^Process/).outerHTML
      await openSplit('Process')
      const item = checkbox(P2).closest('li')
      html.push(
        (controls + (item?.outerHTML ?? '')).replace(/_r_[0-9a-z]+_/g, 'ID'),
      )
      expect(checkbox(P2).getAttribute('aria-label')).toBe(
        'Select card: Start writing ADRs',
      )
      view.unmount()
      queryClient.clear()
      membersMock.fetchProjectMembers.mockClear()
    }
    expect(html[1]).toBe(html[0])
    expect(html[2]).toBe(html[0])
    expect(html[0]).not.toMatch(/split by|merged by|being merged/i)
    expect(html[0]).not.toMatch(
      /aria-label="Select card: [^"]*(Ada|you|Anonymous)/,
    )
  })
})

describe('merge and split errors', () => {
  it.each<[ClusterErrorCode, string]>([
    ['cannot_merge_into_self', 'Choose a different cluster to merge into.'],
    ['cluster_not_found', 'This cluster no longer exists.'],
    ['unknown', 'Could not merge the clusters.'],
    ['card_not_found', 'Could not merge the clusters.'],
  ])(
    'a merge failing with %s shows "%s" and keeps the form and its choice',
    async (code, message) => {
      setup()
      await clusterBoard()
      const errorToast = vi.spyOn(toast, 'error')
      boardMock.mergeClusters.mockRejectedValue(new ClustersApiError(code))
      const select = await openMerge('Process')
      fireEvent.change(select, { target: { value: DOCS.clusterId } })
      fireEvent.click(
        within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
      )
      expect(await screen.findByText(message)).toBeVisible()
      expect(errorToast).toHaveBeenCalledTimes(1)
      expect(errorToast).toHaveBeenCalledWith(message)
      expect(screen.queryByText(code)).toBeNull()
      await waitFor(() => {
        expect(
          within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
        ).not.toBeDisabled()
      })
      expect(mergeSelect().value).toBe(DOCS.clusterId)
      expect(statusText()).toBe('')
    },
  )

  it('a merge whose source is gone toasts, and the refetch closes the form and focuses Cluster name', async () => {
    setup()
    await clusterBoard()
    boardMock.mergeClusters.mockImplementation(() => {
      boardMock.fetchCycleBoard.mockResolvedValue(
        boardOf('cluster', [TOOLS, DOCS]),
      )
      return Promise.reject(new ClustersApiError('cluster_not_found'))
    })
    await openMerge('Process')
    fireEvent.click(
      within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
    )
    expect(
      await screen.findByText('This cluster no longer exists.'),
    ).toBeVisible()
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: /^Merge cluster/ })).toBeNull()
    })
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })
  })

  it.each<[ClusterErrorCode, string]>([
    ['invalid_card_selection', 'Select the cards to move to the new cluster.'],
    [
      'card_not_in_cluster',
      'Some selected cards are no longer in this cluster. Check your selection and try again.',
    ],
    [
      'split_takes_all_cards',
      'Leave at least one card in the cluster. To rename it, use Rename.',
    ],
    [
      'invalid_cluster_name',
      'Enter a cluster name of 1 to 100 characters on one line.',
    ],
    ['cluster_name_taken', 'A cluster with this name already exists.'],
    ['cluster_limit_reached', 'This cycle already has 50 clusters.'],
    ['cluster_not_found', 'This cluster no longer exists.'],
    ['unknown', 'Could not split the cluster.'],
  ])(
    'a split failing with %s shows "%s" and keeps the form, selection and name',
    async (code, message) => {
      setup()
      await clusterBoard()
      const errorToast = vi.spyOn(toast, 'error')
      boardMock.splitCluster.mockRejectedValue(new ClustersApiError(code))
      await openSplit('Process')
      fireEvent.click(checkbox(P2))
      fireEvent.change(splitInput(), { target: { value: 'Meetings' } })
      fireEvent.submit(splitForm())
      expect(await screen.findByText(message)).toBeVisible()
      expect(errorToast).toHaveBeenCalledTimes(1)
      expect(errorToast).toHaveBeenCalledWith(message)
      expect(screen.queryByText(code)).toBeNull()
      await waitFor(() => {
        expect(
          within(splitForm()).getByRole('button', {
            name: 'Split into new cluster',
          }),
        ).not.toBeDisabled()
      })
      expect(checkbox(P2)).toBeChecked()
      expect(splitInput()).toHaveValue('Meetings')
    },
  )

  it('a split whose cluster is gone toasts, and the refetch closes the form and focuses Cluster name', async () => {
    setup()
    await clusterBoard()
    boardMock.splitCluster.mockImplementation(() => {
      boardMock.fetchCycleBoard.mockResolvedValue(
        boardOf('cluster', [TOOLS, DOCS]),
      )
      return Promise.reject(new ClustersApiError('cluster_not_found'))
    })
    await openSplit('Process')
    fireEvent.click(checkbox(P2))
    fireEvent.change(splitInput(), { target: { value: 'Meetings' } })
    fireEvent.submit(splitForm())
    expect(
      await screen.findByText('This cluster no longer exists.'),
    ).toBeVisible()
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: /^Split cluster/ })).toBeNull()
    })
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })
  })

  it.each(['merge', 'split'] as const)(
    'a %s failing with cycle_not_clustering toasts, and the refetched stage unmounts the mode',
    async (kind) => {
      setup()
      await clusterBoard()
      const fail = () => {
        boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
        return Promise.reject(new ClustersApiError('cycle_not_clustering'))
      }
      boardMock.mergeClusters.mockImplementation(fail)
      boardMock.splitCluster.mockImplementation(fail)
      if (kind === 'merge') {
        await openMerge('Process')
        fireEvent.click(
          within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
        )
      } else {
        await openSplit('Process')
        fireEvent.click(checkbox(P2))
        fireEvent.change(splitInput(), { target: { value: 'Meetings' } })
        fireEvent.submit(splitForm())
      }
      expect(
        await screen.findByText(
          'Clusters can only be changed during the Cluster stage.',
        ),
      ).toBeVisible()
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Vote' }),
      ).toBeInTheDocument()
      expect(screen.queryByTestId('cluster-board')).toBeNull()
    },
  )

  it.each(['merge', 'split'] as const)(
    'a %s failing with not_project_member shows the not-found state',
    async (kind) => {
      setup()
      await clusterBoard()
      const lost = new ClustersApiError('not_project_member')
      boardMock.mergeClusters.mockRejectedValue(lost)
      boardMock.splitCluster.mockRejectedValue(lost)
      if (kind === 'merge') {
        await openMerge('Process')
        fireEvent.click(
          within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
        )
      } else {
        await openSplit('Process')
        fireEvent.click(checkbox(P2))
        fireEvent.change(splitInput(), { target: { value: 'Meetings' } })
        fireEvent.submit(splitForm())
      }
      expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
      expect(screen.queryByTestId('cluster-board')).toBeNull()
    },
  )
})

describe('one board write at a time', () => {
  it.each(['merge', 'split'] as const)(
    'while a %s is pending every Move button is aria-disabled and no card is draggable',
    async (kind) => {
      setup({ pointer: 'fine' })
      await clusterBoard()
      expect(document.querySelectorAll('[draggable="true"]').length).toBe(5)
      boardMock.mergeClusters.mockReturnValue(new Promise(() => undefined))
      boardMock.splitCluster.mockReturnValue(new Promise(() => undefined))
      if (kind === 'merge') {
        await openMerge('Process')
        fireEvent.click(
          within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
        )
      } else {
        await openSplit('Process')
        fireEvent.click(checkbox(P2))
        fireEvent.change(splitInput(), { target: { value: 'Meetings' } })
        fireEvent.submit(splitForm())
      }
      await waitFor(() => {
        for (const move of moveButtons()) {
          expect(move).toHaveAttribute('aria-disabled', 'true')
        }
      })
      expect(document.querySelector('[draggable="true"]')).toBeNull()
      const move = moveButtons()[0]
      move.focus()
      fireEvent.keyDown(move, { key: 'Enter' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(boardMock.moveCard).not.toHaveBeenCalled()
    },
  )

  it('while a card move is pending, Merge clusters and Split into new cluster send nothing', async () => {
    setup()
    await clusterBoard()
    boardMock.moveCard.mockReturnValue(new Promise(() => undefined))

    await openMerge('Tools')
    const move = screen.getByRole('button', {
      name: 'Move card: Start pairing',
    })
    move.focus()
    fireEvent.keyDown(move, { key: 'Enter' })
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Move to Docs' }),
    )
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenCalledTimes(1)
    })
    const confirm = within(mergeGroup('Tools')).getByRole('button', {
      name: 'Merge clusters',
    })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(confirm)
    expect(boardMock.mergeClusters).not.toHaveBeenCalled()

    fireEvent.click(
      within(mergeGroup('Tools')).getByRole('button', { name: 'Cancel' }),
    )
    await openSplit('Process')
    fireEvent.click(checkbox(P2))
    fireEvent.change(splitInput(), { target: { value: 'Meetings' } })
    const submit = within(splitForm()).getByRole('button', {
      name: 'Split into new cluster',
    })
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(submit)
    fireEvent.submit(splitForm())
    expect(boardMock.splitCluster).not.toHaveBeenCalled()
  })

  it.each(['merge', 'split'] as const)(
    'focus moved to another cluster before the %s resolves stays there (#94)',
    async (kind) => {
      setup()
      await clusterBoard()
      const merge = deferred<SavedCluster>()
      const split = deferred<SavedCluster>()
      boardMock.mergeClusters.mockReturnValue(merge.promise)
      boardMock.splitCluster.mockReturnValue(split.promise)
      if (kind === 'merge') {
        await openMerge('Process')
        fireEvent.change(mergeSelect(), { target: { value: DOCS.clusterId } })
        fireEvent.click(
          within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
        )
      } else {
        await openSplit('Process')
        fireEvent.click(checkbox(P2))
        fireEvent.change(splitInput(), { target: { value: 'Meetings' } })
        fireEvent.submit(splitForm())
      }
      const elsewhere = button('Rename cluster Tools')
      elsewhere.focus()

      const meetings: BoardCluster = {
        clusterId: NEW_ID,
        name: 'Meetings',
        source: 'manual',
        cardIds: [P2.cardId],
      }
      boardMock.fetchCycleBoard.mockResolvedValue(
        kind === 'merge'
          ? boardOf('cluster', [TOOLS, withCards(DOCS, [P1, P2, P3])])
          : boardOf('cluster', [
              withCards(PROCESS, [P1, P3]),
              TOOLS,
              DOCS,
              meetings,
            ]),
      )
      await act(async () => {
        if (kind === 'merge') {
          merge.resolve(saved(DOCS))
          await merge.promise
        } else {
          split.resolve({
            clusterId: NEW_ID,
            name: 'Meetings',
            source: 'manual',
          })
          await split.promise
        }
      })
      await waitFor(() => {
        expect(statusText()).toBe(
          kind === 'merge'
            ? 'Merged cluster Process into Docs.'
            : 'Split 1 card into Meetings.',
        )
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(elsewhere).toHaveFocus()
    },
  )

  it('two identical merge results are announced twice', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const merged = boardOf('cluster', [
      withCards(TOOLS, [T1, P1, P2, P3]),
      DOCS,
    ])
    boardMock.mergeClusters.mockResolvedValue(saved(TOOLS))
    boardMock.fetchCycleBoard.mockResolvedValue(merged)
    await openMerge('Process')
    fireEvent.click(
      within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
    )
    await waitFor(() => {
      expect(statusText()).toBe('Merged cluster Process into Tools.')
    })
    const status = within(screen.getByTestId('cluster-board')).getByRole(
      'status',
    )
    const first = status.firstElementChild

    // Someone creates another "Process", and it is merged into Tools again.
    await refetchWith(
      boardOf('cluster', [withCards(TOOLS, [T1, P1, P2, P3]), DOCS, PROCESS]),
    )
    boardMock.fetchCycleBoard.mockResolvedValue(merged)
    await openMerge('Process')
    fireEvent.click(
      within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
    )
    await waitFor(() => {
      expect(boardMock.mergeClusters).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(status.firstElementChild).not.toBe(first)
    })
    expect(statusText()).toBe('Merged cluster Process into Tools.')
  })
})

describe('stages', () => {
  it.each(['merge', 'split'] as const)(
    'a stage change to vote while a %s form is open removes every form, box and control',
    async (kind) => {
      setup()
      await clusterBoard()
      await subscribed()
      if (kind === 'merge') {
        await openMerge('Process')
      } else {
        await openSplit('Process')
        fireEvent.click(checkbox(P2))
      }
      boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
      emitEvent()
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Vote' }),
      ).toBeInTheDocument()
      expect(screen.queryByRole('group', { name: /^Merge cluster/ })).toBeNull()
      expect(screen.queryByRole('form', { name: /^Split cluster/ })).toBeNull()
      expect(screen.queryByRole('checkbox')).toBeNull()
      expect(
        screen.queryByRole('button', { name: /^(Merge|Split)/ }),
      ).toBeNull()
    },
  )

  it.each(['merge', 'split'] as const)(
    'a pending %s that loses the race to the stage change shows its toast',
    async (kind) => {
      setup()
      await clusterBoard()
      await subscribed()
      const pending = deferred<SavedCluster>()
      boardMock.mergeClusters.mockReturnValue(pending.promise)
      boardMock.splitCluster.mockReturnValue(pending.promise)
      if (kind === 'merge') {
        await openMerge('Process')
        fireEvent.click(
          within(mergeGroup()).getByRole('button', { name: 'Merge clusters' }),
        )
      } else {
        await openSplit('Process')
        fireEvent.click(checkbox(P2))
        fireEvent.change(splitInput(), { target: { value: 'Meetings' } })
        fireEvent.submit(splitForm())
      }
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
    },
  )

  it.each(['reveal', 'vote', 'discuss', 'closed'] as const)(
    'in %s there is no Merge, Split or card checkbox',
    async (status) => {
      setup({ board: boardOf(status) })
      await screen.findByRole('heading', { level: 2 })
      await waitFor(() => {
        expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
      })
      expect(
        screen.queryByRole('button', { name: /^(Merge|Split)/ }),
      ).toBeNull()
      expect(screen.queryByRole('checkbox')).toBeNull()
    },
  )
})

describe('long names at phone width', () => {
  it('a 100-character unbroken name wraps anywhere in the control row, the sentence, the label, the options and the messages', async () => {
    const long = 'N'.repeat(100)
    const longProcess = { ...PROCESS, name: long }
    setup({ board: boardOf('cluster', [longProcess, TOOLS, DOCS]) })
    await clusterBoard()

    const row = button(`Merge cluster ${long}`).parentElement
    expect(row?.className).toContain('flex-wrap')

    await openMerge('Tools')
    const option = Array.from(mergeSelect('Tools').options)[0]
    expect(option.textContent).toBe(`${long} (3 cards)`)
    expect(option.className).toContain('[overflow-wrap:anywhere]')
    expect(mergeSelect('Tools').className).toContain('w-full')
    expect(mergeSelect('Tools').className).toContain('min-w-0')
    const sentence = within(mergeGroup('Tools')).getByText(/^Move the 1 card/)
    expect(sentence.className).toContain('[overflow-wrap:anywhere]')
    expect(sentence.className).toContain('min-w-0')
    expect(sentence.className).not.toContain('break-words')

    await openSplit(long)
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box.className).toContain('size-6')
    }
    expect(
      within(splitForm(long)).getByText('New cluster name').className,
    ).toContain('[overflow-wrap:anywhere]')
    for (const card of [P1, P2, P3]) {
      fireEvent.click(checkbox(card))
    }
    fireEvent.submit(splitForm(long))
    const alert = within(splitForm(long)).getByRole('alert')
    expect(alert).toHaveTextContent(`Leave at least one card in ${long}.`)
    expect(alert.className).toContain('[overflow-wrap:anywhere]')
    expect(alert.className).not.toContain('break-words')
  })
})
