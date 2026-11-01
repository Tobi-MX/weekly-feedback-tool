import {
  act,
  createEvent,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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
import { CARD_DRAG_TYPE } from './cardMove'
import { ClustersApiError, type ClusterErrorCode } from './clusterErrors'

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

// Ungrouped: u1, u2 (server order). Process: p1, p2, p3.
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
const P3: BoardCard = {
  cardId: 'e0000000-0000-4000-8000-000000000005',
  category: 'stop',
  text: LONG_TEXT,
  isAnonymous: false,
  isMine: false,
  authorDisplayName: null,
}
const CARDS = [U1, U2, P1, P2, P3]

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

function withCards(
  cluster: BoardCluster,
  cards: readonly BoardCard[],
): BoardCluster {
  return { ...cluster, cardIds: cards.map((card) => card.cardId) }
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

function moveButton(card: BoardCard): HTMLElement {
  const text =
    [...card.text].length > 40
      ? `${[...card.text].slice(0, 40).join('')}…`
      : card.text
  return screen.getByRole('button', { name: `Move card: ${text}` })
}

function section(name: RegExp): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name })
  const element = heading.closest('section')
  if (element === null) {
    throw new Error(`no section for ${String(name)}`)
  }
  return element
}

/** The card texts of a section's list, in order. */
function textsIn(name: RegExp): string[] {
  const list = within(section(name)).queryByRole('list')
  if (list === null) {
    return []
  }
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelectorAll('p')[1]?.textContent ?? '')
}

function headings(): string[] {
  return within(screen.getByTestId('cluster-board'))
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent)
}

function statusText(): string {
  return within(screen.getByTestId('cluster-board')).getByRole('status')
    .textContent
}

async function openMenu(button: HTMLElement): Promise<HTMLElement> {
  button.focus()
  fireEvent.keyDown(button, { key: 'Enter' })
  return screen.findByRole('menu')
}

function menuLabels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent)
}

function item(menu: HTMLElement, name: string): HTMLElement {
  return within(menu).getByRole('menuitem', { name })
}

async function choose(card: BoardCard, name: string): Promise<void> {
  const menu = await openMenu(moveButton(card))
  fireEvent.click(item(menu, name))
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

/** A minimal DataTransfer: jsdom has none. */
function dataTransfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const setData = vi.fn((type: string, value: string) => {
    data.set(type, value)
  })
  return {
    get types() {
      return [...data.keys()]
    },
    files: [],
    dropEffect: 'none',
    effectAllowed: 'all',
    setData,
    getData: (type: string) => data.get(type) ?? '',
  }
}

type FakeTransfer = ReturnType<typeof dataTransfer>

function drag(
  kind: 'dragStart' | 'dragOver' | 'dragLeave' | 'drop' | 'dragEnd',
  element: Element,
  transfer: FakeTransfer,
  clientY?: number,
) {
  const event = createEvent[kind](element, { dataTransfer: transfer })
  if (clientY !== undefined) {
    Object.defineProperty(event, 'clientY', { value: clientY })
  }
  fireEvent(element, event)
}

function cardItem(card: BoardCard): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `li[data-card-id="${card.cardId}"]`,
  )
  if (element === null) {
    throw new Error(`no item for ${card.text}`)
  }
  return element
}

/** Gives the Process list's items 80 px tall boxes 100 px apart. */
function layOutList(name: RegExp) {
  const items = within(section(name)).getAllByRole('listitem')
  items.forEach((element, index) => {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: index * 100, width: 200, height: 80 }),
    )
  })
}

describe('the Move button and menu', () => {
  it('every card shows a Move button named after its text, cut to 40 characters', async () => {
    setup()
    await clusterBoard()
    for (const card of [U1, U2, P1, P2]) {
      expect(moveButton(card)).toHaveTextContent('Move')
    }
    expect(
      screen.getByRole('button', {
        name: `Move card: ${LONG_TEXT.slice(0, 40)}…`,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: /^Move card: / }),
    ).toHaveLength(5)
  })

  it('an ungrouped card has no Move button when there are no clusters', async () => {
    setup({ board: boardOf('cluster', []) })
    await clusterBoard()
    expect(screen.queryByRole('button', { name: /^Move card: / })).toBeNull()
  })

  it.each<[string, BoardCard, readonly BoardCluster[], string[]]>([
    [
      'an ungrouped card with two clusters',
      U1,
      [PROCESS, TOOLS],
      ['Move to Process', 'Move to Tools'],
    ],
    [
      'the first card of three',
      P1,
      [PROCESS, TOOLS],
      ['Move down', 'Move to Ungrouped', 'Move to Tools'],
    ],
    [
      'the middle card of three',
      P2,
      [PROCESS, TOOLS],
      ['Move up', 'Move down', 'Move to Ungrouped', 'Move to Tools'],
    ],
    [
      'the last card of three',
      P3,
      [PROCESS, TOOLS],
      ['Move up', 'Move to Ungrouped', 'Move to Tools'],
    ],
    [
      'a single card in a cluster',
      P1,
      [withCards(PROCESS, [P1]), TOOLS],
      ['Move to Ungrouped', 'Move to Tools'],
    ],
  ])('the menu of %s', async (_label, card, clusters, expected) => {
    setup({ board: boardOf('cluster', clusters) })
    await clusterBoard()
    const menu = await openMenu(moveButton(card))
    expect(menuLabels(menu)).toEqual(expected)
  })

  it('works by keyboard only: Enter opens on the first item, arrows move, Enter moves, Escape closes', async () => {
    setup()
    await clusterBoard()
    boardMock.moveCard.mockReturnValue(new Promise(() => undefined))

    const button = moveButton(U1)
    const menu = await openMenu(button)
    await waitFor(() => {
      expect(item(menu, 'Move to Process')).toHaveFocus()
    })
    fireEvent.keyDown(item(menu, 'Move to Process'), { key: 'ArrowDown' })
    await waitFor(() => {
      expect(item(menu, 'Move to Tools')).toHaveFocus()
    })
    fireEvent.keyDown(item(menu, 'Move to Tools'), { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    expect(button).toHaveFocus()
    expect(boardMock.moveCard).not.toHaveBeenCalled()

    const again = await openMenu(button)
    fireEvent.keyDown(item(again, 'Move to Process'), { key: 'ArrowDown' })
    fireEvent.keyDown(item(again, 'Move to Tools'), { key: 'Enter' })
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenCalledTimes(1)
    })
    expect(boardMock.moveCard).toHaveBeenCalledWith(
      U1.cardId,
      TOOLS.clusterId,
      null,
    )
  })

  it.each<[string, BoardCard, string, string | null, number | null]>([
    ['Move up', P2, 'Move up', PROCESS.clusterId, 0],
    ['Move down', P2, 'Move down', PROCESS.clusterId, 2],
    ['Move to Ungrouped', P2, 'Move to Ungrouped', null, null],
  ])(
    '%s sends the matching move_card arguments',
    async (_label, card, name, clusterId, position) => {
      setup()
      await clusterBoard()
      boardMock.moveCard.mockReturnValue(new Promise(() => undefined))
      await choose(card, name)
      await waitFor(() => {
        expect(boardMock.moveCard).toHaveBeenCalledTimes(1)
      })
      expect(boardMock.moveCard).toHaveBeenCalledWith(
        card.cardId,
        clusterId,
        position,
      )
    },
  )
})

describe('optimistic moves', () => {
  it('shows the move at once, blocks other moves, and sends one request for a double activation', async () => {
    setup()
    await clusterBoard()
    const pending = deferred<undefined>()
    boardMock.moveCard.mockReturnValue(pending.promise)

    const menu = await openMenu(moveButton(U1))
    const target = item(menu, 'Move to Tools')
    fireEvent.click(target)
    fireEvent.click(target)

    await waitFor(() => {
      expect(textsIn(/^Tools/)).toEqual(['Start pairing'])
    })
    expect(headings()).toEqual(['Ungrouped (1)', 'Process (3)', 'Tools (1)'])
    expect(textsIn(/^Ungrouped/)).toEqual(['Continue demos'])
    expect(boardMock.moveCard).toHaveBeenCalledTimes(1)

    const other = moveButton(U2)
    expect(other).toHaveAttribute('aria-disabled', 'true')
    other.focus()
    fireEvent.keyDown(other, { key: 'Enter' })
    fireEvent.pointerDown(other, { button: 0, ctrlKey: false })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(boardMock.moveCard).toHaveBeenCalledTimes(1)
  })

  it('a refetch while the move is pending keeps the card in place; the refetch after it keeps it there too', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const pending = deferred<undefined>()
    boardMock.moveCard.mockReturnValue(pending.promise)

    await choose(U1, 'Move to Tools')
    await waitFor(() => {
      expect(textsIn(/^Tools/)).toEqual(['Start pairing'])
    })

    // Another member's change lands while the move is in flight.
    const before = boardMock.fetchCycleBoard.mock.calls.length
    emitEvent()
    await waitFor(() => {
      expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(
        before,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(textsIn(/^Tools/)).toEqual(['Start pairing'])

    // The server's board after the move, behind a slow refetch.
    const refetch = deferred<CycleBoard | null>()
    boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })
    expect(textsIn(/^Tools/)).toEqual(['Start pairing'])
    expect(statusText()).toBe('')
    expect(moveButton(U2)).toHaveAttribute('aria-disabled', 'true')

    await act(async () => {
      refetch.resolve(boardOf('cluster', [PROCESS, withCards(TOOLS, [U1])]))
      await refetch.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe('Moved card to Tools, position 1 of 1.')
    })
    expect(textsIn(/^Tools/)).toEqual(['Start pairing'])
    expect(moveButton(U2)).not.toHaveAttribute('aria-disabled')
  })

  it("success announces the place and focuses the moved card's Move button in its new list", async () => {
    setup()
    await clusterBoard()
    const pending = deferred<undefined>()
    boardMock.moveCard.mockReturnValue(pending.promise)

    await choose(P1, 'Move down')
    await waitFor(() => {
      expect(textsIn(/^Process/)).toEqual([
        'Start writing ADRs',
        'Stop late merges',
        LONG_TEXT,
      ])
    })
    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [withCards(PROCESS, [P2, P1, P3]), TOOLS]),
    )
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe('Moved card to Process, position 2 of 3.')
    })
    expect(moveButton(P1)).toHaveFocus()
    expect(
      within(section(/^Process/)).getByRole('button', {
        name: 'Move card: Stop late merges',
      }),
    ).toHaveFocus()
  })

  it('announces Ungrouped and focuses the card there', async () => {
    setup()
    await clusterBoard()
    boardMock.moveCard.mockResolvedValue(undefined)
    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [withCards(PROCESS, [P1, P3]), TOOLS]),
    )
    await choose(P2, 'Move to Ungrouped')
    await waitFor(() => {
      expect(statusText()).toBe('Moved card to Ungrouped.')
    })
    // Ungrouped is in response order: P2 sits between U2 and P3's place.
    expect(textsIn(/^Ungrouped/)).toEqual([
      'Start pairing',
      'Continue demos',
      'Start writing ADRs',
    ])
    expect(
      within(section(/^Ungrouped/)).getByRole('button', {
        name: 'Move card: Start writing ADRs',
      }),
    ).toHaveFocus()
  })

  it('does not take focus back when the user moved on before the move finished (#94)', async () => {
    setup()
    await clusterBoard()
    const pending = deferred<undefined>()
    boardMock.moveCard.mockReturnValue(pending.promise)

    await choose(U1, 'Move to Tools')
    await waitFor(() => {
      expect(textsIn(/^Tools/)).toEqual(['Start pairing'])
    })
    const input = screen.getByRole('textbox', { name: 'Cluster name' })
    input.focus()

    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [PROCESS, withCards(TOOLS, [U1])]),
    )
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe('Moved card to Tools, position 1 of 1.')
    })
    expect(input).toHaveFocus()
  })

  it.each<[ClusterErrorCode, string]>([
    ['card_not_found', 'This card no longer exists.'],
    ['cluster_not_found', 'This cluster no longer exists.'],
    [
      'cycle_not_clustering',
      'Cards can only be moved during the Cluster stage.',
    ],
    ['invalid_card_position', 'Could not move the card.'],
    ['unknown', 'Could not move the card.'],
  ])(
    'a move failing with %s shows "%s", returns the card, and focuses its Move button',
    async (code, message) => {
      setup()
      await clusterBoard()
      const pending = deferred<undefined>()
      boardMock.moveCard.mockReturnValue(pending.promise)
      const errorToast = vi.spyOn(toast, 'error')

      await choose(U1, 'Move to Tools')
      await waitFor(() => {
        expect(textsIn(/^Tools/)).toEqual(['Start pairing'])
      })
      const before = boardMock.fetchCycleBoard.mock.calls.length
      await act(async () => {
        pending.reject(new ClustersApiError(code))
        await pending.promise.catch(() => undefined)
      })

      expect(await screen.findByText(message)).toBeVisible()
      expect(errorToast).toHaveBeenCalledTimes(1)
      expect(errorToast).toHaveBeenCalledWith(message)
      expect(screen.queryByText(code)).toBeNull()
      expect(textsIn(/^Tools/)).toEqual([])
      expect(textsIn(/^Ungrouped/)).toEqual(['Start pairing', 'Continue demos'])
      await waitFor(() => {
        expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(
          before,
        )
      })
      await waitFor(() => {
        expect(moveButton(U1)).toHaveFocus()
      })
      expect(statusText()).toBe('')
    },
  )

  it('not_project_member switches to the not-found state', async () => {
    setup()
    await clusterBoard()
    boardMock.moveCard.mockRejectedValue(
      new ClustersApiError('not_project_member'),
    )
    await choose(U1, 'Move to Tools')
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.queryByTestId('cluster-board')).toBeNull()
  })
})

describe('live changes around a move', () => {
  it('an open menu follows renames and deletes, and closes when its card moves elsewhere', async () => {
    setup()
    await clusterBoard()
    await subscribed()

    const menu = await openMenu(moveButton(U1))
    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [PROCESS, { ...TOOLS, name: 'Tooling' }]),
    )
    emitEvent()
    await waitFor(() => {
      expect(menuLabels(menu)).toEqual(['Move to Process', 'Move to Tooling'])
    })

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [PROCESS]))
    emitEvent()
    await waitFor(() => {
      expect(menuLabels(screen.getByRole('menu'))).toEqual(['Move to Process'])
    })

    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [withCards(PROCESS, [P1, P2, P3, U1])]),
    )
    emitEvent()
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    await waitFor(() => {
      expect(
        within(section(/^Process/)).getByRole('button', {
          name: 'Move card: Start pairing',
        }),
      ).toHaveFocus()
    })
    expect(boardMock.moveCard).not.toHaveBeenCalled()
  })

  it('a stage change to vote while a menu is open removes every Move control and renders Vote', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    await openMenu(moveButton(U1))

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
    emitEvent()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Move card: / })).toBeNull()
    expect(boardMock.moveCard).not.toHaveBeenCalled()
  })

  it('a pending move that loses the race to the stage change shows its toast', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const pending = deferred<undefined>()
    boardMock.moveCard.mockReturnValue(pending.promise)
    await choose(U1, 'Move to Tools')

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
    emitEvent()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Move card: / })).toBeNull()

    await act(async () => {
      pending.reject(new ClustersApiError('cycle_not_clustering'))
      await pending.promise.catch(() => undefined)
    })
    expect(
      await screen.findByText(
        'Cards can only be moved during the Cluster stage.',
      ),
    ).toBeVisible()
  })

  it.each(['reveal', 'vote', 'discuss', 'closed'] as const)(
    'in %s there is no Move button and no draggable card',
    async (status) => {
      setup({ board: boardOf(status), pointer: 'fine' })
      await screen.findByRole('heading', { level: 2 })
      await waitFor(() => {
        expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
      })
      expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull()
      expect(document.querySelector('[draggable="true"]')).toBeNull()
    },
  )
})

describe('anonymity of the Move control', () => {
  it('an anonymous card renders identical DOM for two members and its author; every role sees the same controls', async () => {
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
      html.push(
        cardItem(P2).outerHTML.replace(/_r_[0-9a-z]+_/g, 'ID') +
          screen
            .getByTestId('cluster-board')
            .outerHTML.replace(/_r_[0-9a-z]+_/g, 'ID'),
      )
      view.unmount()
      queryClient.clear()
      membersMock.fetchProjectMembers.mockClear()
    }
    expect(html[1]).toBe(html[0])
    expect(html[2]).toBe(html[0])
    expect(html[0]).not.toMatch(/moved by|being moved/i)
  })
})

describe('drag and drop', () => {
  it('cards are draggable on fine pointers only; coarse pointers still move through the menu', async () => {
    const view = setup({ pointer: 'fine' })
    await clusterBoard()
    for (const card of CARDS) {
      expect(cardItem(card)).toHaveAttribute('draggable', 'true')
    }
    view.unmount()
    queryClient.clear()

    setup({ pointer: 'coarse' })
    await clusterBoard()
    expect(document.querySelector('[draggable="true"]')).toBeNull()
    boardMock.moveCard.mockReturnValue(new Promise(() => undefined))
    await choose(U1, 'Move to Process')
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenCalledWith(
        U1.cardId,
        PROCESS.clusterId,
        null,
      )
    })
  })

  it('dragstart carries only the card id; dragover shows the ring and the line; drop moves once and shows it at once', async () => {
    setup({ pointer: 'fine' })
    await clusterBoard()
    const pending = deferred<undefined>()
    boardMock.moveCard.mockReturnValue(pending.promise)
    layOutList(/^Process/)

    const transfer = dataTransfer()
    drag('dragStart', cardItem(U1), transfer)
    expect(transfer.setData).toHaveBeenCalledTimes(1)
    expect(transfer.setData).toHaveBeenCalledWith(CARD_DRAG_TYPE, U1.cardId)
    expect(transfer.types).toEqual([CARD_DRAG_TYPE])

    // Below P2's midpoint (140), above P3's (240): insert before P3.
    drag('dragOver', cardItem(P2), transfer, 150)
    expect(section(/^Process/)).toHaveClass('ring-2')
    expect(cardItem(P3)).toHaveAttribute('data-drop-line', 'before')
    expect(section(/^Tools/)).not.toHaveClass('ring-2')

    drag('drop', cardItem(P2), transfer, 150)
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenCalledTimes(1)
    })
    expect(boardMock.moveCard).toHaveBeenCalledWith(
      U1.cardId,
      PROCESS.clusterId,
      2,
    )
    await waitFor(() => {
      expect(textsIn(/^Process/)).toEqual([
        'Stop late merges',
        'Start writing ADRs',
        'Start pairing',
        LONG_TEXT,
      ])
    })
    expect(section(/^Process/)).not.toHaveClass('ring-2')
    expect(document.querySelector('[data-drop-line]')).toBeNull()
    // No card can be dragged while the move is pending.
    expect(document.querySelector('[draggable="true"]')).toBeNull()
  })

  it('after the last card the line shows below it', async () => {
    setup({ pointer: 'fine' })
    await clusterBoard()
    layOutList(/^Process/)
    const transfer = dataTransfer()
    drag('dragStart', cardItem(U1), transfer)
    drag('dragOver', cardItem(P3), transfer, 290)
    expect(cardItem(P3)).toHaveAttribute('data-drop-line', 'after')
  })

  it('drops on Ungrouped ungroup, and drops on a heading or an empty cluster append', async () => {
    setup({ pointer: 'fine' })
    await clusterBoard()
    boardMock.moveCard.mockResolvedValue(undefined)

    let transfer = dataTransfer()
    drag('dragStart', cardItem(P1), transfer)
    drag('dragOver', section(/^Ungrouped/), transfer)
    expect(section(/^Ungrouped/)).toHaveClass('ring-2')
    drag('drop', section(/^Ungrouped/), transfer)
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenLastCalledWith(P1.cardId, null, null)
    })
    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: /^Move card: / })[0],
      ).not.toHaveAttribute('aria-disabled')
    })

    transfer = dataTransfer()
    drag('dragStart', cardItem(U1), transfer)
    const heading = within(section(/^Process/)).getByRole('heading')
    drag('dragOver', heading, transfer, 0)
    drag('drop', heading, transfer, 0)
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenLastCalledWith(
        U1.cardId,
        PROCESS.clusterId,
        null,
      )
    })
    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: /^Move card: / })[0],
      ).not.toHaveAttribute('aria-disabled')
    })

    transfer = dataTransfer()
    drag('dragStart', cardItem(U2), transfer)
    const empty = within(section(/^Tools/)).getByText(
      'No cards in this cluster yet.',
    )
    drag('dragOver', empty, transfer)
    drag('drop', empty, transfer)
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenLastCalledWith(
        U2.cardId,
        TOOLS.clusterId,
        null,
      )
    })
  })

  it('sends nothing for a drop in place, outside a target, without a drop, of other data, or of a card not on the board', async () => {
    setup({ pointer: 'fine' })
    await clusterBoard()
    layOutList(/^Process/)

    // P2 dropped where it is (between P1 and P3's midpoints, around itself).
    let transfer = dataTransfer()
    drag('dragStart', cardItem(P2), transfer)
    drag('dragOver', cardItem(P2), transfer, 120)
    drag('drop', cardItem(P2), transfer, 120)
    // P3 dropped on its own cluster's heading: it is already last.
    transfer = dataTransfer()
    drag('dragStart', cardItem(P3), transfer)
    drag('drop', within(section(/^Process/)).getByRole('heading'), transfer, 0)
    // An ungrouped card dropped on Ungrouped.
    transfer = dataTransfer()
    drag('dragStart', cardItem(U1), transfer)
    drag('drop', section(/^Ungrouped/), transfer)
    // Dropped outside any target, then dragend.
    transfer = dataTransfer()
    drag('dragStart', cardItem(U1), transfer)
    drag(
      'dragOver',
      screen.getByRole('form', { name: 'New cluster' }),
      transfer,
    )
    drag('drop', screen.getByRole('form', { name: 'New cluster' }), transfer)
    drag('dragEnd', cardItem(U1), transfer)
    // Text and files from another app.
    drag('drop', section(/^Tools/), dataTransfer({ 'text/plain': U1.cardId }))
    drag('drop', section(/^Tools/), dataTransfer({ Files: '' }))
    // A card id from another tab or cycle.
    drag(
      'drop',
      section(/^Tools/),
      dataTransfer({
        [CARD_DRAG_TYPE]: '99999999-0000-4000-8000-000000000009',
      }),
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(boardMock.moveCard).not.toHaveBeenCalled()
    expect(document.querySelector('[data-drop-line]')).toBeNull()
    expect(document.querySelector('section.ring-2')).toBeNull()
    expect(statusText()).toBe('')
  })

  it('a cluster renamed mid-drag still takes the drop and announces its new name; a removed one is gone', async () => {
    setup({ pointer: 'fine' })
    await clusterBoard()
    await subscribed()
    boardMock.moveCard.mockResolvedValue(undefined)

    const transfer = dataTransfer()
    drag('dragStart', cardItem(U1), transfer)
    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [{ ...PROCESS, name: 'Ways of working' }, TOOLS]),
    )
    emitEvent()
    await screen.findByRole('heading', { name: 'Ways of working (3)' })
    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [
        {
          ...PROCESS,
          name: 'Ways of working',
          cardIds: [...PROCESS.cardIds, U1.cardId],
        },
        TOOLS,
      ]),
    )
    drag(
      'drop',
      within(section(/^Ways of working/)).getByRole('heading'),
      transfer,
      0,
    )
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenCalledWith(
        U1.cardId,
        PROCESS.clusterId,
        null,
      )
    })
    await waitFor(() => {
      expect(statusText()).toBe(
        'Moved card to Ways of working, position 4 of 4.',
      )
    })
    expect(
      within(section(/^Ways of working/)).getByRole('button', {
        name: 'Move card: Start pairing',
      }),
    ).toHaveFocus()

    const next = dataTransfer()
    drag('dragStart', cardItem(U2), next)
    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [
        {
          ...PROCESS,
          name: 'Ways of working',
          cardIds: [...PROCESS.cardIds, U1.cardId],
        },
      ]),
    )
    emitEvent()
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /^Tools/ })).toBeNull()
    })
    expect(
      document.querySelector(`[data-drop-target="${TOOLS.clusterId}"]`),
    ).toBeNull()
    drag('dragEnd', cardItem(U2), next)
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenCalledTimes(1)
    })
  })

  it('a stage change during a drag ends it with no request', async () => {
    setup({ pointer: 'fine' })
    await clusterBoard()
    await subscribed()
    const transfer = dataTransfer()
    const dragged = cardItem(U1)
    drag('dragStart', dragged, transfer)

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
    emitEvent()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()
    drag('dragEnd', dragged, transfer)
    expect(document.querySelector('[data-drop-target]')).toBeNull()
    expect(boardMock.moveCard).not.toHaveBeenCalled()
  })

  it('drops into a cluster list compute the index against the card midpoints, the dragged card excluded', async () => {
    setup({ pointer: 'fine' })
    await clusterBoard()
    boardMock.moveCard.mockReturnValue(new Promise(() => undefined))
    layOutList(/^Process/)

    // P1 (index 0) dropped below P2's midpoint: before P3, position 1.
    const transfer = dataTransfer()
    drag('dragStart', cardItem(P1), transfer)
    drag('drop', cardItem(P3), transfer, 200)
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenCalledWith(
        P1.cardId,
        PROCESS.clusterId,
        1,
      )
    })
    await waitFor(() => {
      expect(textsIn(/^Process/)).toEqual([
        'Start writing ADRs',
        'Stop late merges',
        LONG_TEXT,
      ])
    })
  })
})
