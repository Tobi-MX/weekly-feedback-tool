import {
  act,
  fireEvent,
  getDefaultNormalizer,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionApiError, type ActionErrorCode } from '../board/actionErrors'
import type { CycleSummary, ProjectCycles } from '../cycles/cyclesApi'
import { queryClient } from '../lib/queryClient'
import { actionsMock } from '../test/actionsMock'
import { deferred, mockRestoredSession } from '../test/authMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { projectActionsMock } from '../test/projectActionsMock'
import { projectsMock } from '../test/projectsMock'
import { renderApp } from '../test/renderApp'
import type { ProjectMember } from './membersApi'
import type {
  ProjectAction,
  ProjectActionFilters,
  ProjectActions,
} from './projectActionsApi'
import type { ProjectSummary } from './projectsApi'

const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/projects/${PROJECT_ID}`
const DISCUSS_CYCLE = '30000000-0000-4000-8000-000000000001'
const CLOSED_CYCLE = '30000000-0000-4000-8000-000000000002'
const NOT_FOUND = 'Project not found or you do not have access.'
const LOADING = 'Loading action items…'
const LOAD_ERROR = 'Could not load the action items.'
const MARKED_DONE = 'Action item marked done.'
const REOPENED = 'Action item reopened.'
const T = '2026-11-01T09:00:00.000Z'

const project: ProjectSummary = {
  id: PROJECT_ID,
  name: 'Alpha Project',
  created_at: '2026-10-30T12:00:00.000Z',
}

const currentCycle: CycleSummary = {
  id: DISCUSS_CYCLE,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'discuss',
  createdAt: '2026-10-30T12:00:00.000Z',
  closedAt: null,
}

const pastCycle: CycleSummary = {
  id: CLOSED_CYCLE,
  title: 'Sprint eleven retro',
  weekStart: '2026-10-19',
  status: 'closed',
  createdAt: '2026-10-20T12:00:00.000Z',
  closedAt: '2026-10-24T12:00:00.000Z',
}

const cycles: ProjectCycles = { current: currentCycle, past: [pastCycle] }

function member(
  userId: string,
  role: 'facilitator' | 'member',
  isMe: boolean,
  isOwner = false,
): ProjectMember {
  return {
    userId,
    displayName: isMe ? 'Dev User' : `Person ${userId}`,
    role,
    isOwner,
    isMe,
    joinedAt: '2026-10-30T12:00:00.000Z',
  }
}

const asFacilitator: ProjectMember[] = [
  member('user-1', 'facilitator', true, true),
  member('user-2', 'member', false),
]
const asMember: ProjectMember[] = [
  member('user-1', 'member', true),
  member('user-2', 'facilitator', false, true),
]
const asOwnerNotFacilitator: ProjectMember[] = [
  member('user-1', 'member', true, true),
  member('user-2', 'facilitator', false),
]

let nextId = 1

function action(
  description: string,
  overrides: Partial<ProjectAction> = {},
): ProjectAction {
  const n = nextId++
  const status = overrides.status ?? 'open'
  return {
    actionId: `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    clusterId: 'c1000000-0000-4000-8000-000000000001',
    description,
    ownerId: 'user-2',
    ownerName: 'Dan',
    ownerIsMe: false,
    createdByMe: false,
    dueDate: '2026-11-12',
    status,
    completedAt: status === 'done' ? '2026-11-03T08:00:00.000Z' : null,
    source: 'manual',
    createdAt: T,
    updatedAt: T,
    cycleId: CLOSED_CYCLE,
    cycleTitle: 'Sprint eleven retro',
    cycleStatus: 'closed',
    clusterName: 'Testing',
    ...overrides,
  }
}

function mine(description: string, overrides: Partial<ProjectAction> = {}) {
  return action(description, {
    ownerId: 'user-1',
    ownerName: 'Dev User',
    ownerIsMe: true,
    ...overrides,
  })
}

/** The mocked server: every action, its order, and optional totals. */
interface Server {
  open: ProjectAction[]
  done: ProjectAction[]
  openCount?: number
  doneCount?: number
}

let server: Server = { open: [], done: [] }

/** Answers like get_project_actions: filters, lists in server order. */
function answer(filters: ProjectActionFilters): ProjectActions {
  const keep = (item: ProjectAction) => !filters.mineOnly || item.ownerIsMe
  const open = server.open.filter(keep)
  const done = server.done.filter(keep)
  return {
    projectId: PROJECT_ID,
    status: filters.status,
    mineOnly: filters.mineOnly,
    openCount: server.openCount ?? open.length,
    doneCount: server.doneCount ?? done.length,
    open: filters.status === 'done' ? [] : open,
    done: filters.status === 'open' ? [] : done,
  }
}

interface SetupOptions {
  readonly members?: ProjectMember[]
  readonly cycles?: ProjectCycles
  /** Fakes the timers too (still advancing with real time), for the poll. */
  readonly fakeTimers?: boolean
}

function setup(next: Server, options: SetupOptions = {}) {
  // Local noon on Nov 3, 2026: "today" is 2026-11-03 in any time zone.
  if (options.fakeTimers) {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    })
  } else {
    vi.useFakeTimers({ toFake: ['Date'] })
  }
  vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0))
  server = next
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  projectsMock.fetchProject.mockResolvedValue(project)
  membersMock.fetchProjectMembers.mockResolvedValue(
    options.members ?? asFacilitator,
  )
  cyclesMock.fetchProjectCycles.mockResolvedValue(options.cycles ?? cycles)
  projectActionsMock.fetchProjectActions.mockImplementation((_id, filters) =>
    Promise.resolve(answer(filters)),
  )
  return renderApp({ initialEntries: [PATH] })
}

afterEach(() => {
  vi.useRealTimers()
})

function section(): HTMLElement {
  return screen.getByRole('region', { name: 'Action items' })
}

async function findSection(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Action items' })
}

/** Waits for the first list to be shown. */
async function ready(): Promise<HTMLElement> {
  const region = await findSection()
  await waitFor(() => {
    expect(within(region).queryByText(LOADING)).toBeNull()
  })
  await waitFor(() => {
    expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
  })
  return region
}

function statusRegion(): HTMLElement {
  const region = section().querySelector<HTMLElement>('p[aria-live="polite"]')
  if (!region) {
    throw new Error('no status region')
  }
  return region
}

/** Matches text exactly, line breaks included. */
const exact = {
  normalizer: getDefaultNormalizer({ trim: false, collapseWhitespace: false }),
}

function item(description: string): HTMLElement {
  const text = within(section()).getByText(description, exact)
  const li = text.closest('li')
  if (!li) {
    throw new Error(`no item ${description}`)
  }
  return li
}

function listHeading(name: RegExp | string): HTMLElement {
  return within(section()).getByRole('heading', { level: 3, name })
}

function itemsOf(list: 'Open' | 'Done'): string[] {
  const heading = listHeading(new RegExp(`^${list} \\(`))
  const ul = heading.parentElement?.querySelector('ul')
  if (!ul) {
    return []
  }
  return [...ul.querySelectorAll(':scope > li > p:first-child')].map(
    (p) => p.textContent ?? '',
  )
}

function filterButton(name: 'Open' | 'Done' | 'All'): HTMLElement {
  return within(
    within(section()).getByRole('group', { name: 'Show' }),
  ).getByRole('button', { name })
}

function mineBox(): HTMLElement {
  return within(section()).getByRole('checkbox', { name: 'Assigned to me' })
}

function lastFilters(): ProjectActionFilters | undefined {
  return projectActionsMock.fetchProjectActions.mock.calls.at(-1)?.[1]
}

function toggles(): HTMLElement[] {
  return within(section()).queryAllByRole('button', {
    name: /^(Mark done|Reopen): /,
  })
}

describe('placement and first read', () => {
  it('shows the header, Current cycle, Action items, then Past cycles', async () => {
    setup({ open: [action('Write the runbook')], done: [] })
    await ready()
    await screen.findByRole('heading', { level: 2, name: 'Past cycles' })

    const headings = screen
      .getAllByRole('heading')
      .filter((h) => h.tagName === 'H1' || h.tagName === 'H2')
      .map((h) => h.textContent)
    expect(headings).toEqual([
      'Alpha Project',
      'Current cycle',
      'Action items',
      'Past cycles',
    ])
    expect(projectActionsMock.fetchProjectActions).toHaveBeenCalledWith(
      PROJECT_ID,
      { status: 'open', mineOnly: false },
    )
    expect(projectActionsMock.fetchProjectActions.mock.calls[0][1]).toEqual({
      status: 'open',
      mineOnly: false,
    })
    expect(filterButton('Open')).toHaveAttribute('aria-pressed', 'true')
    expect(filterButton('Done')).toHaveAttribute('aria-pressed', 'false')
    expect(filterButton('All')).toHaveAttribute('aria-pressed', 'false')
    expect(mineBox()).not.toBeChecked()
  })
})

describe('items', () => {
  it('shows each line as text, in the server order', async () => {
    const later = mine('Later\nsecond line', {
      dueDate: '2026-11-20',
      clusterName: 'Deploys',
      cycleId: DISCUSS_CYCLE,
      cycleTitle: 'Sprint twelve retro',
      cycleStatus: 'discuss',
    })
    const sooner = action('Sooner', {
      dueDate: null,
      clusterId: null,
      clusterName: null,
    })
    const finished = action('Finished', {
      status: 'done',
      completedAt: '2026-11-03T08:00:00.000Z',
    })
    setup({ open: [later, sooner], done: [finished] })
    await ready()
    fireEvent.click(filterButton('All'))
    await within(section()).findByText('Finished')

    // Never re-sorted: the server's order.
    expect(itemsOf('Open')).toEqual(['Later\nsecond line', 'Sooner'])

    const first = item('Later\nsecond line')
    const description = within(first).getByText('Later\nsecond line', exact)
    expect(description).toHaveClass('whitespace-pre-wrap')
    expect(description.textContent).toBe('Later\nsecond line')
    expect(within(first).getByText('Owner: Dev User (you)')).toBeVisible()
    expect(within(first).getByText('Due Nov 20, 2026')).toBeVisible()
    expect(within(first).getByText('Topic: Deploys')).toBeVisible()
    expect(first).toHaveTextContent('Retrospective: Sprint twelve retro')
    expect(within(first).getByText('Status: Open')).toBeVisible()

    const second = item('Sooner')
    expect(within(second).getByText('Owner: Dan')).toBeVisible()
    expect(within(second).getByText('No due date')).toBeVisible()
    expect(within(second).getByText('No related topic')).toBeVisible()

    const done = item('Finished')
    expect(
      within(done).getByText('Status: Done · Completed Nov 3, 2026'),
    ).toBeVisible()
    expect(within(done).getByText('Due Nov 12, 2026')).toBeVisible()
  })

  it('labels overdue open actions as text, by the local date', async () => {
    setup({
      open: [
        action('Yesterday', { dueDate: '2026-11-02' }),
        action('Today', { dueDate: '2026-11-03' }),
        action('Tomorrow', { dueDate: '2026-11-04' }),
        action('Undated', { dueDate: null }),
      ],
      done: [action('Old done', { status: 'done', dueDate: '2025-11-03' })],
    })
    await ready()
    fireEvent.click(filterButton('All'))
    await within(section()).findByText('Old done')

    expect(
      within(item('Yesterday')).getByText('Due Nov 2, 2026 · Overdue'),
    ).toBeVisible()
    expect(within(item('Today')).getByText('Due Nov 3, 2026')).toBeVisible()
    expect(within(item('Tomorrow')).getByText('Due Nov 4, 2026')).toBeVisible()
    expect(within(item('Undated')).getByText('No due date')).toBeVisible()
    expect(within(item('Old done')).getByText('Due Nov 3, 2025')).toBeVisible()
    expect(within(section()).getAllByText(/Overdue/)).toHaveLength(1)
  })

  it('gains the Overdue label after local midnight and a poll', async () => {
    setup(
      { open: [action('Today', { dueDate: '2026-11-03' })], done: [] },
      { fakeTimers: true },
    )
    await ready()
    expect(within(item('Today')).getByText('Due Nov 3, 2026')).toBeVisible()

    // Just past local midnight; the next poll re-renders the list.
    vi.setSystemTime(new Date(2026, 10, 4, 0, 0, 30))
    const before = projectActionsMock.fetchProjectActions.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(
      projectActionsMock.fetchProjectActions.mock.calls.length,
    ).toBeGreaterThan(before)
    expect(
      within(item('Today')).getByText('Due Nov 3, 2026 · Overdue'),
    ).toBeVisible()
  })

  it('links a discuss cycle to its board and leaves a closed one as text', async () => {
    setup({
      open: [
        action('In discuss', {
          cycleId: DISCUSS_CYCLE,
          cycleTitle: 'Sprint twelve retro',
          cycleStatus: 'discuss',
        }),
        action('In closed'),
      ],
      done: [],
    })
    await ready()

    const link = within(item('In discuss')).getByRole('link', {
      name: 'Sprint twelve retro',
    })
    expect(link).toHaveAttribute('href', `/cycles/${DISCUSS_CYCLE}/board`)
    expect(within(item('In closed')).queryByRole('link')).toBeNull()
    expect(item('In closed')).toHaveTextContent(
      'Retrospective: Sprint eleven retro',
    )
  })

  it('renders HTML-like text as text, wraps long words, and lists extraction actions', async () => {
    const longWord = 'x'.repeat(500)
    setup({
      open: [
        action('<b>bold</b><script>alert(1)</script>'),
        action(longWord, {
          clusterName: 'T'.repeat(100),
          cycleTitle: 'C'.repeat(100),
        }),
        action('Extracted', { source: 'extraction' }),
      ],
      done: [],
    })
    await ready()

    const html = item('<b>bold</b><script>alert(1)</script>')
    expect(html.querySelector('b')).toBeNull()
    expect(html.querySelector('script')).toBeNull()

    const long = item(longWord)
    expect(within(long).getByText(longWord)).toHaveClass(
      '[overflow-wrap:anywhere]',
    )
    const details = within(long).getByText(
      `Topic: ${'T'.repeat(100)}`,
    ).parentElement
    expect(details).toHaveClass('[overflow-wrap:anywhere]')
    expect(long).toHaveTextContent(`Retrospective: ${'C'.repeat(100)}`)

    const extracted = item('Extracted')
    expect(within(extracted).getByText('Owner: Dan')).toBeVisible()
    expect(within(extracted).getByText('Topic: Testing')).toBeVisible()
  })
})

describe('filters', () => {
  it('each filter change reads once with its filters, keeps focus, and shows Loading until it answers', async () => {
    setup({
      open: [mine('Mine open'), action('Their open')],
      done: [action('Their done', { status: 'done' })],
      openCount: 7,
      doneCount: 3,
    })
    await ready()
    expect(listHeading('Open (7)')).toBeVisible()
    expect(
      within(section()).queryByRole('heading', { name: /^Done/ }),
    ).toBeNull()

    const steps: readonly [() => HTMLElement, ProjectActionFilters][] = [
      [() => filterButton('Done'), { status: 'done', mineOnly: false }],
      [() => filterButton('All'), { status: 'all', mineOnly: false }],
      [mineBox, { status: 'all', mineOnly: true }],
    ]
    for (const [control, filters] of steps) {
      const pending = deferred<ProjectActions>()
      projectActionsMock.fetchProjectActions.mockImplementationOnce(
        () => pending.promise,
      )
      const before = projectActionsMock.fetchProjectActions.mock.calls.length
      control().focus()
      fireEvent.click(control())
      expect(await within(section()).findByText(LOADING)).toBeVisible()
      expect(control()).toHaveFocus()
      expect(projectActionsMock.fetchProjectActions.mock.calls.length).toBe(
        before + 1,
      )
      expect(lastFilters()).toEqual(filters)
      await act(async () => {
        pending.resolve(answer(filters))
        await pending.promise
      })
      await waitFor(() => {
        expect(within(section()).queryByText(LOADING)).toBeNull()
      })
      expect(control()).toHaveFocus()
    }

    expect(filterButton('All')).toHaveAttribute('aria-pressed', 'true')
    expect(mineBox()).toBeChecked()
  })

  it('Done shows only Done, All shows Open then Done, with the counts from the totals', async () => {
    setup({
      open: [action('Open one')],
      done: [action('Done one', { status: 'done' })],
      openCount: 4,
      doneCount: 9,
    })
    await ready()
    fireEvent.click(filterButton('Done'))
    expect(await within(section()).findByText('Done one')).toBeVisible()
    expect(listHeading('Done (9)')).toBeVisible()
    expect(
      within(section()).queryByRole('heading', { name: /^Open/ }),
    ).toBeNull()

    fireEvent.click(filterButton('All'))
    expect(await within(section()).findByText('Open one')).toBeVisible()
    const order = within(section())
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    expect(order).toEqual(['Open (4)', 'Done (9)'])
  })

  it('shows the limit notes only when a total is above what was returned', async () => {
    const open = Array.from({ length: 200 }, (_, i) => action(`Open ${i}`))
    const done = Array.from({ length: 20 }, (_, i) =>
      action(`Done ${i}`, { status: 'done' }),
    )
    // A plain member, so the 220 items render no toggles (a faster test).
    setup({ open, done, openCount: 201, doneCount: 25 }, { members: asMember })
    await ready()
    fireEvent.click(filterButton('All'))
    await within(section()).findByText('Done 0')
    expect(
      within(section()).getByText('Showing 200 of 201 open action items.'),
    ).toBeVisible()
    expect(
      within(section()).getByText(
        'Showing the 20 most recently completed of 25.',
      ),
    ).toBeVisible()

    server = { open, done }
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['project-actions'] })
    })
    await waitFor(() => {
      expect(within(section()).queryByText(/^Showing/)).toBeNull()
    })
    expect(listHeading('Open (200)')).toBeVisible()
    expect(listHeading('Done (20)')).toBeVisible()
  }, 30_000)

  it.each([
    ['open', false, 'No open action items.', ['Open (0)']],
    ['open', true, 'No open action items are assigned to you.', ['Open (0)']],
    ['done', false, 'No completed action items yet.', ['Done (0)']],
    [
      'done',
      true,
      'No completed action items are assigned to you.',
      ['Done (0)'],
    ],
    [
      'all',
      false,
      'No action items yet. They are added on the retrospective board during the Discuss stage.',
      [],
    ],
    ['all', true, 'No action items are assigned to you.', []],
  ] as const)(
    'empty: %s with Assigned to me %s shows its copy',
    async (status, mineOnly, copy, headings) => {
      // Someone else's action, so "Assigned to me" empties the lists.
      setup(
        mineOnly
          ? { open: [action('Theirs')], done: [] }
          : { open: [], done: [] },
      )
      await ready()
      if (status !== 'open') {
        fireEvent.click(filterButton(status === 'done' ? 'Done' : 'All'))
      }
      if (mineOnly) {
        fireEvent.click(mineBox())
      }
      expect(await within(section()).findByText(copy)).toBeVisible()
      expect(
        within(section())
          .queryAllByRole('heading', { level: 3 })
          .map((h) => h.textContent),
      ).toEqual(headings)
      expect(within(section()).queryByRole('list')).toBeNull()
    },
  )
})

describe('controls', () => {
  const data = () => ({
    open: [
      mine('My action'),
      action('Their action'),
      action('Orphan', { ownerId: null, ownerName: null }),
    ],
    done: [],
  })

  it('a member gets the toggle only on their own actions; no Edit or Delete anywhere', async () => {
    setup(data(), { members: asMember })
    await ready()
    expect(toggles().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Mark done: My action',
    ])
    expect(
      within(section()).queryByRole('button', { name: /Edit|Delete/ }),
    ).toBeNull()
    expect(
      within(item('Orphan')).getByText('Owner: Deleted account'),
    ).toBeVisible()
  })

  it('the facilitator gets the toggle on every action, the deleted account included', async () => {
    setup(data(), { members: asFacilitator })
    await ready()
    await waitFor(() => {
      expect(toggles()).toHaveLength(3)
    })
    expect(toggles().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Mark done: My action',
      'Mark done: Their action',
      'Mark done: Orphan',
    ])
    expect(
      within(section()).queryByRole('button', { name: /Edit|Delete/ }),
    ).toBeNull()
  })

  it('the project owner who is not the facilitator gets it only on their own', async () => {
    setup(data(), { members: asOwnerNotFacilitator })
    await ready()
    expect(toggles()).toHaveLength(1)
    expect(toggles()[0]).toHaveAccessibleName('Mark done: My action')
  })

  it("while the members load or after they fail, only the caller's own actions get a toggle", async () => {
    const members = deferred<ProjectMember[] | null>()
    membersMock.fetchProjectMembers.mockImplementation(() => members.promise)
    setup(data())
    membersMock.fetchProjectMembers.mockImplementation(() => members.promise)
    await within(await findSection()).findByText('Their action')
    expect(toggles()).toHaveLength(1)
    await act(async () => {
      members.reject(new Error('down'))
      await members.promise.catch(() => undefined)
    })
    expect(toggles()).toHaveLength(1)
    expect(toggles()[0]).toHaveAccessibleName('Mark done: My action')
  })

  it('uses a 40-character excerpt in the accessible name', async () => {
    const text = 'abcdefghij'.repeat(5)
    setup({ open: [mine(text)], done: [] })
    await ready()
    expect(toggles()[0]).toHaveAccessibleName(
      `Mark done: ${text.slice(0, 40)}…`,
    )
  })
})

describe('status writes', () => {
  function spyInvalidations() {
    return vi.spyOn(queryClient, 'invalidateQueries')
  }

  it('Mark done under Open: one call, pending state, then gone, announced once, focus on the Open heading', async () => {
    const target = mine('Ship it', { cycleId: DISCUSS_CYCLE })
    const other = mine('Another')
    setup({ open: [target, other], done: [] })
    await ready()
    const invalidate = spyInvalidations()
    const write = deferred<undefined>()
    actionsMock.setActionStatus.mockImplementation(() => write.promise)

    const button = within(item('Ship it')).getByRole('button', {
      name: 'Mark done: Ship it',
    })
    button.focus()
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter', repeat: true })
    fireEvent.click(button)
    expect(await within(item('Ship it')).findByText('Updating…')).toBeVisible()
    fireEvent.click(button)
    expect(actionsMock.setActionStatus).toHaveBeenCalledTimes(1)
    expect(actionsMock.setActionStatus).toHaveBeenCalledWith(
      target.actionId,
      'done',
    )
    for (const toggle of toggles()) {
      expect(toggle).toHaveAttribute('aria-disabled', 'true')
    }
    fireEvent.click(
      within(item('Another')).getByRole('button', { name: /Another/ }),
    )
    expect(actionsMock.setActionStatus).toHaveBeenCalledTimes(1)
    // Nothing changed on screen before the re-read.
    expect(item('Ship it')).toHaveTextContent('Status: Open')

    server = {
      open: [other],
      done: [{ ...target, status: 'done', completedAt: T }],
    }
    await act(async () => {
      write.resolve(undefined)
      await write.promise
    })

    await waitFor(() => {
      expect(within(section()).queryByText('Ship it')).toBeNull()
    })
    await waitFor(() => {
      expect(listHeading('Open (1)')).toHaveFocus()
    })
    expect(statusRegion()).toHaveTextContent(MARKED_DONE)
    expect(screen.getAllByText(MARKED_DONE)).toHaveLength(1)
    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey)
    expect(keys).toContainEqual(['project-actions', 'user-1', PROJECT_ID])
    expect(keys).toContainEqual(['cycle-actions', 'user-1', DISCUSS_CYCLE])
  })

  it('the filters still work while a write is pending', async () => {
    const target = mine('Ship it')
    setup({ open: [target], done: [] })
    await ready()
    const write = deferred<undefined>()
    actionsMock.setActionStatus.mockImplementation(() => write.promise)
    fireEvent.click(
      within(item('Ship it')).getByRole('button', { name: /Ship it/ }),
    )
    await within(item('Ship it')).findByText('Updating…')

    fireEvent.click(filterButton('Done'))
    await waitFor(() => {
      expect(lastFilters()).toEqual({ status: 'done', mineOnly: false })
    })
    expect(filterButton('Done')).toHaveAttribute('aria-pressed', 'true')
    await act(async () => {
      write.resolve(undefined)
      await write.promise
    })
  })

  it('Mark done under All: the item moves to Done with focus on its Reopen', async () => {
    const target = mine('Ship it')
    setup({ open: [target], done: [] })
    await ready()
    fireEvent.click(filterButton('All'))
    await within(section()).findByRole('heading', { name: 'Done (0)' })
    actionsMock.setActionStatus.mockImplementation(() => {
      server = {
        open: [],
        done: [{ ...target, status: 'done', completedAt: T }],
      }
      return Promise.resolve()
    })

    const button = within(item('Ship it')).getByRole('button', {
      name: 'Mark done: Ship it',
    })
    button.focus()
    fireEvent.click(button)

    await waitFor(() => {
      expect(
        within(section()).getByRole('button', { name: 'Reopen: Ship it' }),
      ).toHaveFocus()
    })
    expect(itemsOf('Done')).toEqual(['Ship it'])
    expect(itemsOf('Open')).toEqual([])
    expect(statusRegion()).toHaveTextContent(MARKED_DONE)
  })

  it('Reopen under Done: one call with open, gone, announced, focus on the Done heading', async () => {
    const target = mine('Reopen me', { status: 'done' })
    setup({ open: [], done: [target, mine('Keep', { status: 'done' })] })
    await ready()
    fireEvent.click(filterButton('Done'))
    await within(section()).findByText('Reopen me')
    actionsMock.setActionStatus.mockImplementation(() => {
      server = {
        open: [{ ...target, status: 'open', completedAt: null }],
        done: server.done.filter((a) => a.actionId !== target.actionId),
      }
      return Promise.resolve()
    })

    const button = within(item('Reopen me')).getByRole('button', {
      name: 'Reopen: Reopen me',
    })
    button.focus()
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => {
      expect(listHeading('Done (1)')).toHaveFocus()
    })
    expect(actionsMock.setActionStatus).toHaveBeenCalledTimes(1)
    expect(actionsMock.setActionStatus).toHaveBeenCalledWith(
      target.actionId,
      'open',
    )
    expect(statusRegion()).toHaveTextContent(REOPENED)
  })

  it('Reopen under All: the item moves to Open with focus on its Mark done', async () => {
    const target = mine('Reopen me', { status: 'done' })
    setup({ open: [], done: [target] })
    await ready()
    fireEvent.click(filterButton('All'))
    await within(section()).findByText('Reopen me')
    actionsMock.setActionStatus.mockImplementation(() => {
      server = {
        open: [{ ...target, status: 'open', completedAt: null }],
        done: [],
      }
      return Promise.resolve()
    })
    const button = within(item('Reopen me')).getByRole('button', {
      name: 'Reopen: Reopen me',
    })
    button.focus()
    fireEvent.click(button)
    await waitFor(() => {
      expect(
        within(section()).getByRole('button', { name: 'Mark done: Reopen me' }),
      ).toHaveFocus()
    })
    expect(statusRegion()).toHaveTextContent(REOPENED)
  })

  it('does not steal focus from a filter the user moved to', async () => {
    const target = mine('Ship it')
    setup({ open: [target], done: [] })
    await ready()
    const write = deferred<undefined>()
    actionsMock.setActionStatus.mockImplementation(() => write.promise)
    fireEvent.click(
      within(item('Ship it')).getByRole('button', { name: /Ship it/ }),
    )
    await within(item('Ship it')).findByText('Updating…')
    filterButton('Open').focus()

    server = { open: [], done: [{ ...target, status: 'done', completedAt: T }] }
    await act(async () => {
      write.resolve(undefined)
      await write.promise
    })
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent(MARKED_DONE)
    })
    await waitFor(() => {
      expect(within(section()).queryByText('Ship it')).toBeNull()
    })
    expect(filterButton('Open')).toHaveFocus()
  })

  const ERRORS: readonly [ActionErrorCode, string][] = [
    [
      'not_action_owner',
      "Only the action's owner or the facilitator can change its status.",
    ],
    ['action_not_found', 'This action item no longer exists.'],
    ['cycle_not_discussing', 'Could not update the action item.'],
    ['invalid_action_status', 'Could not update the action item.'],
    ['unknown', 'Could not update the action item.'],
  ]

  it.each(ERRORS)(
    '%s shows its exact toast once and re-reads the list',
    async (code, message) => {
      const target = mine('Ship it')
      setup({ open: [target], done: [] })
      await ready()
      const write = deferred<undefined>()
      actionsMock.setActionStatus.mockImplementation(() => write.promise)
      fireEvent.click(
        within(item('Ship it')).getByRole('button', { name: /Ship it/ }),
      )
      await within(item('Ship it')).findByText('Updating…')
      const before = projectActionsMock.fetchProjectActions.mock.calls.length
      const members = membersMock.fetchProjectMembers.mock.calls.length
      await act(async () => {
        write.reject(new ActionApiError(code))
        await write.promise.catch(() => undefined)
      })
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getAllByText(message)).toHaveLength(1)
      await waitFor(() => {
        expect(
          projectActionsMock.fetchProjectActions.mock.calls.length,
        ).toBeGreaterThan(before)
      })
      expect(item('Ship it')).toHaveTextContent('Status: Open')
      expect(statusRegion()).toHaveTextContent('')
      if (code === 'not_action_owner') {
        await waitFor(() => {
          expect(
            membersMock.fetchProjectMembers.mock.calls.length,
          ).toBeGreaterThan(members)
        })
      }
    },
  )

  it("not_action_owner re-reads the members, and the toggle on another's action disappears", async () => {
    const theirs = action('Theirs')
    setup({ open: [theirs], done: [] }, { members: asFacilitator })
    await ready()
    await waitFor(() => {
      expect(toggles()).toHaveLength(1)
    })
    actionsMock.setActionStatus.mockRejectedValue(
      new ActionApiError('not_action_owner'),
    )
    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    fireEvent.click(toggles()[0])
    expect(
      await screen.findByText(
        "Only the action's owner or the facilitator can change its status.",
      ),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(toggles()).toHaveLength(0)
    })
  })

  it('not_project_member shows no toast and the page reaches its not-found state', async () => {
    setup({ open: [mine('Ship it')], done: [] })
    await ready()
    actionsMock.setActionStatus.mockRejectedValue(
      new ActionApiError('not_project_member'),
    )
    projectsMock.fetchProject.mockResolvedValue(null)
    fireEvent.click(toggles()[0])
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.queryByText(/^Could not/)).toBeNull()
    expect(screen.queryByText(/facilitator can change/)).toBeNull()
  })

  it('navigating away while a write is pending announces nothing, moves no focus and logs no error', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const errors = vi.spyOn(console, 'error')
      const view = setup({ open: [mine('Ship it')], done: [] })
      await ready()
      const write = deferred<undefined>()
      actionsMock.setActionStatus.mockImplementation(() => write.promise)
      fireEvent.click(toggles()[0])
      await within(item('Ship it')).findByText('Updating…')

      fireEvent.click(screen.getByRole('link', { name: 'Members' }))
      await waitFor(() => {
        expect(
          screen.queryByRole('region', { name: 'Action items' }),
        ).toBeNull()
      })
      const focused = document.activeElement
      await act(async () => {
        if (outcome === 'resolve') {
          write.resolve(undefined)
        } else {
          write.reject(new ActionApiError('unknown'))
        }
        await write.promise.catch(() => undefined)
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(document.activeElement).toBe(focused)
      expect(screen.queryByText(MARKED_DONE)).toBeNull()
      expect(screen.queryByText('Could not update the action item.')).toBeNull()
      expect(errors).not.toHaveBeenCalled()
      errors.mockRestore()
      view.unmount()
      queryClient.clear()
    }
  })
})

describe('states', () => {
  it('shows Loading action items… while Current cycle and Past cycles render', async () => {
    const pending = deferred<ProjectActions>()
    setup({ open: [], done: [] })
    projectActionsMock.fetchProjectActions.mockImplementation(
      () => pending.promise,
    )
    const region = await findSection()
    expect(within(region).getByText(LOADING)).toBeVisible()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Past cycles' }),
    ).toBeVisible()
    expect(await screen.findByText('Sprint twelve retro')).toBeVisible()
    expect(filterButton('Open')).toBeVisible()
    await act(async () => {
      pending.resolve(answer({ status: 'open', mineOnly: false }))
      await pending.promise
    })
  })

  it('a failed read shows the alert with Retry, which re-reads and renders the list; filters stay usable', async () => {
    setup({ open: [action('After retry')], done: [] })
    projectActionsMock.fetchProjectActions.mockRejectedValue(
      new ActionApiError('unknown'),
    )
    const region = await findSection()
    const alert = await within(region).findByRole('alert')
    expect(alert).toHaveTextContent(LOAD_ERROR)
    expect(filterButton('Done')).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'Current cycle' })).toBeVisible()

    projectActionsMock.fetchProjectActions.mockImplementation((_id, filters) =>
      Promise.resolve(answer(filters)),
    )
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await within(region).findByText('After retry')).toBeVisible()
    expect(within(region).queryByRole('alert')).toBeNull()
  })

  it('invalid_action_filter shows the load error copy', async () => {
    setup({ open: [], done: [] })
    projectActionsMock.fetchProjectActions.mockRejectedValue(
      new ActionApiError('invalid_action_filter'),
    )
    const region = await findSection()
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      LOAD_ERROR,
    )
  })

  it('a not_project_member read shows the not-found state', async () => {
    setup({ open: [], done: [] })
    projectActionsMock.fetchProjectActions.mockRejectedValue(
      new ActionApiError('not_project_member'),
    )
    await findSection()
    projectsMock.fetchProject.mockResolvedValue(null)
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
  })

  it('a failed cycles read leaves the Action items section working', async () => {
    setup({ open: [action('Still here')], done: [] })
    cyclesMock.fetchProjectCycles.mockRejectedValue(new Error('down'))
    const region = await findSection()
    expect(await within(region).findByText('Still here')).toBeVisible()
    expect(await screen.findByText('Could not load the cycles.')).toBeVisible()
    fireEvent.click(filterButton('All'))
    await waitFor(() => {
      expect(lastFilters()).toEqual({ status: 'all', mineOnly: false })
    })
  })
})

describe('live updates', () => {
  it("re-reads on the current cycle's channel without a second channel", async () => {
    setup({ open: [action('First')], done: [] })
    await ready()
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })
    const before = projectActionsMock.fetchProjectActions.mock.calls.length
    server = { open: [action('First'), action('Added elsewhere')], done: [] }
    act(() => {
      cyclesMock.emitCycleEvent(DISCUSS_CYCLE)
    })
    expect(await within(section()).findByText('Added elsewhere')).toBeVisible()
    expect(
      projectActionsMock.fetchProjectActions.mock.calls.length,
    ).toBeGreaterThan(before)
    expect(cyclesMock.subscribeToCycleEvents).toHaveBeenCalledTimes(1)
    expect(statusRegion()).toHaveTextContent('')
  })

  it('re-reads every 30 s while visible and on window focus; a changed status shows and announces nothing', async () => {
    const target = action('Changes')
    setup({ open: [target], done: [] }, { fakeTimers: true })
    await ready()
    fireEvent.click(filterButton('All'))
    await within(section()).findByRole('heading', { name: 'Done (0)' })

    let before = projectActionsMock.fetchProjectActions.mock.calls.length
    server = { open: [], done: [{ ...target, status: 'done', completedAt: T }] }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(
      projectActionsMock.fetchProjectActions.mock.calls.length,
    ).toBeGreaterThan(before)
    expect(lastFilters()).toEqual({ status: 'all', mineOnly: false })
    await waitFor(() => {
      expect(itemsOf('Done')).toEqual(['Changes'])
    })
    expect(statusRegion()).toHaveTextContent('')

    before = projectActionsMock.fetchProjectActions.mock.calls.length
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(
        projectActionsMock.fetchProjectActions.mock.calls.length,
      ).toBeGreaterThan(before)
    })
  })
})

describe('vanishing controls', () => {
  it('a refetch that removes the focused item moves focus to its list heading', async () => {
    const target = mine('Going away')
    setup({ open: [target, mine('Staying')], done: [] })
    await ready()
    within(item('Going away'))
      .getByRole('button', { name: /Going away/ })
      .focus()

    server = { open: server.open.filter((a) => a !== target), done: [] }
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['project-actions'] })
    })
    await waitFor(() => {
      expect(listHeading('Open (1)')).toHaveFocus()
    })
  })

  it('with focus elsewhere, a removal moves no focus', async () => {
    const target = mine('Going away')
    setup({ open: [target, mine('Staying')], done: [] })
    await ready()
    const staying = within(item('Staying')).getByRole('button', {
      name: /Staying/,
    })
    staying.focus()
    server = { open: server.open.filter((a) => a !== target), done: [] }
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['project-actions'] })
    })
    await waitFor(() => {
      expect(within(section()).queryByText('Going away')).toBeNull()
    })
    expect(staying).toHaveFocus()
  })

  it("a members re-read that makes the caller a plain member moves focus from another's toggle to the list heading", async () => {
    setup(
      { open: [action('Theirs'), mine('Mine')], done: [] },
      {
        members: asFacilitator,
      },
    )
    await ready()
    await waitFor(() => {
      expect(toggles()).toHaveLength(2)
    })
    within(item('Theirs'))
      .getByRole('button', { name: /Theirs/ })
      .focus()
    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['project-members'] })
    })
    await waitFor(() => {
      expect(toggles()).toHaveLength(1)
    })
    expect(listHeading('Open (2)')).toHaveFocus()
  })
})

describe('sameness', () => {
  it('the facilitator, the owner who is not facilitator, and a member get the same DOM but for (you) and the toggles', async () => {
    const snapshots: string[] = []
    for (const members of [asFacilitator, asOwnerNotFacilitator, asMember]) {
      nextId = 1
      const view = setup(
        {
          open: [
            mine('Mine'),
            action('Theirs', {
              cycleId: DISCUSS_CYCLE,
              cycleStatus: 'discuss',
              cycleTitle: 'Sprint twelve retro',
            }),
          ],
          done: [action('Done', { status: 'done' })],
        },
        { members },
      )
      await ready()
      fireEvent.click(filterButton('All'))
      await within(section()).findByText('Done')
      await waitFor(() => {
        expect(toggles().length).toBeGreaterThan(0)
      })
      const clone = section().cloneNode(true) as HTMLElement
      for (const toggle of clone.querySelectorAll(
        '[data-project-action-toggle]',
      )) {
        toggle.parentElement?.remove()
      }
      snapshots.push(clone.innerHTML.replaceAll(' (you)', ''))
      view.unmount()
      queryClient.clear()
    }
    expect(snapshots[1]).toBe(snapshots[0])
    expect(snapshots[2]).toBe(snapshots[0])
  })
})
