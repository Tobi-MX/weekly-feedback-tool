import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { mockRestoredSession } from '../test/authMock'
import { cyclesMock } from '../test/cyclesMock'
import { profileMock } from '../test/profileMock'
import { projectsMock } from '../test/projectsMock'
import { renderApp } from '../test/renderApp'

// The feedback form is a real screen; its heading is the cycle's title.
const FEEDBACK_CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const FEEDBACK_PATH = `/cycles/${FEEDBACK_CYCLE_ID}/feedback`

async function renderSignedIn(
  path: string,
  heading: string | RegExp = 'Projects',
): Promise<HTMLElement> {
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  if (path.startsWith('/projects/')) {
    projectsMock.fetchProject.mockResolvedValue({
      id: 'project-1',
      name: 'Project One',
      created_at: '2026-10-30T12:00:00.000Z',
    })
  }
  if (path === FEEDBACK_PATH) {
    cyclesMock.fetchCycle.mockResolvedValue({
      id: FEEDBACK_CYCLE_ID,
      projectId: '10000000-0000-4000-8000-000000000001',
      title: 'Feedback cycle',
      weekStart: '2026-10-26',
      status: 'collecting',
    })
  }
  renderApp({ initialEntries: [path] })
  return screen.findByRole('heading', { name: heading })
}

function primaryNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Primary' })
}

function activeNavLinks(): HTMLElement[] {
  return within(primaryNav()).queryAllByRole('link', {
    current: 'page',
  })
}

async function openUserMenuWithKeyboard(): Promise<HTMLElement> {
  const trigger = screen.getByRole('button', { name: /Account menu for/ })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  await screen.findByRole('menu')
  return trigger
}

async function openMobileMenu(): Promise<{
  trigger: HTMLElement
  dialog: HTMLElement
}> {
  const trigger = screen.getByRole('button', { name: 'Open menu' })
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog')
  return { trigger, dialog }
}

function mockDesktopMediaQuery(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    matches: initialMatches,
    media: '(min-width: 768px)',
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      listeners.add(listener)
    },
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      listeners.delete(listener)
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockReturnValue(mediaQuery)

  return {
    setMatches(matches: boolean) {
      for (const listener of listeners) {
        listener({ matches } as MediaQueryListEvent)
      }
    },
  }
}

describe('AppShell', () => {
  it('renders one banner, one primary nav, one main, and the product identity', async () => {
    await renderSignedIn('/projects')

    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getAllByRole('navigation')).toHaveLength(1)

    const brand = screen.getByRole('link', { name: 'Weekly Feedback Tool' })
    expect(brand).toHaveAttribute('href', '/projects')

    const projectsLink = screen.getByRole('link', { name: 'Projects' })
    expect(projectsLink).toHaveAttribute('href', '/projects')
    expect(projectsLink.tagName).toBe('A')

    const userMenu = await screen.findByRole('button', {
      name: 'Account menu for Dev User',
    })
    expect(userMenu.tagName).toBe('BUTTON')

    const heading = screen.getByRole('heading', { name: 'Projects' })
    expect(screen.getByRole('main')).toContainElement(heading)
  })

  it.each<[string, string, number]>([
    ['/projects', 'Projects', 1],
    ['/projects/project-1', 'Project One', 1],
    [FEEDBACK_PATH, 'Feedback cycle', 0],
    ['/cycles/abc/board', 'Retrospective board', 0],
    ['/cycles/abc/upload', 'Meeting upload', 0],
    ['/cycles/abc/summary', 'Retrospective summary', 0],
  ])(
    'marks the expected primary link current on %s',
    async (path, heading, activeCount) => {
      await renderSignedIn(path, heading)

      expect(activeNavLinks()).toHaveLength(activeCount)
      const projectsLink = screen.getByRole('link', { name: 'Projects' })
      if (activeCount === 1) {
        expect(projectsLink).toHaveAttribute('aria-current', 'page')
      } else {
        expect(projectsLink).not.toHaveAttribute('aria-current')
      }
    },
  )

  it('opens the user menu from the keyboard and returns focus on Escape', async () => {
    await renderSignedIn('/projects')

    const trigger = await openUserMenuWithKeyboard()

    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Dev User')).toBeInTheDocument()
    expect(within(menu).getByText('dev@example.com')).toBeInTheDocument()
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(
      within(menu).getByRole('menuitem', { name: 'Sign out' }),
    ).toBeInTheDocument()

    // The menu has no profile, settings, avatar, or upload controls.
    expect(within(menu).queryByRole('img')).not.toBeInTheDocument()
    expect(
      within(menu).queryByRole('button', { name: /profile|settings|upload/i }),
    ).not.toBeInTheDocument()

    fireEvent.keyDown(menu, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('exposes an accessible mobile menu trigger whose aria-controls target exists', async () => {
    await renderSignedIn('/projects')

    const trigger = screen.getByRole('button', { name: 'Open menu' })
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    const controls = trigger.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(document.getElementById(controls ?? '')).toBeInTheDocument()
  })

  it('keeps the mobile Projects link out of the document while the menu is closed', async () => {
    await renderSignedIn('/projects')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('link', { name: 'Projects' })).toHaveLength(1)
  })

  it('opens the mobile menu with the same active state and closes with Escape', async () => {
    await renderSignedIn('/projects/project-1', 'Project One')

    const { trigger, dialog } = await openMobileMenu()

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const mobileLink = within(dialog).getByRole('link', { name: 'Projects' })
    expect(mobileLink).toHaveAttribute('href', '/projects')
    expect(mobileLink).toHaveAttribute('aria-current', 'page')
    expect(
      within(dialog).getByRole('heading', { name: 'Navigation' }),
    ).toBeInTheDocument()

    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('closes the mobile menu after navigating to another route', async () => {
    await renderSignedIn('/projects/project-1', 'Project One')

    const { dialog } = await openMobileMenu()
    fireEvent.click(within(dialog).getByRole('link', { name: 'Projects' }))

    expect(
      await screen.findByRole('heading', { name: 'Projects' }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/projects')
  })

  it('closes the mobile menu when the viewport grows past the breakpoint', async () => {
    const media = mockDesktopMediaQuery(false)

    await renderSignedIn('/projects')
    const { dialog } = await openMobileMenu()
    expect(dialog).toBeInTheDocument()

    act(() => {
      media.setMatches(true)
    })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: 'Open menu' }),
    ).not.toBeInTheDocument()
    expect(screen.queryAllByRole('link', { name: 'Projects' })).toHaveLength(1)
  })

  it('omits the mobile menu trigger at the desktop breakpoint', async () => {
    mockDesktopMediaQuery(true)

    await renderSignedIn('/projects')

    expect(
      screen.queryByRole('button', { name: 'Open menu' }),
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Projects' })).toHaveLength(1)
  })

  it('closes the mobile menu when Projects is already the current route', async () => {
    await renderSignedIn('/projects')

    const { dialog } = await openMobileMenu()
    fireEvent.click(within(dialog).getByRole('link', { name: 'Projects' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(
      screen.getByRole('heading', { name: 'Projects' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/projects')
  })
})
