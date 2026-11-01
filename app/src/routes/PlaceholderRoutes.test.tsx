import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  authMock,
  makeSession,
  mockEmptySession,
  mockRestoredSession,
} from '../test/authMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'

function locationText(): string {
  return screen.getByTestId('location').textContent ?? ''
}

function renderSignedIn(path: string, navigationLog?: string[]) {
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  return renderApp({ initialEntries: [path], navigationLog })
}

describe('placeholder routes', () => {
  it.each<[string, string]>([
    ['/cycles/cycle-secret-id/board', 'Retrospective board'],
    ['/cycles/cycle-secret-id/upload', 'Meeting upload'],
    ['/cycles/cycle-secret-id/summary', 'Retrospective summary'],
  ])('renders the %s placeholder inside the shell', async (path, heading) => {
    renderSignedIn(path)

    expect(
      await screen.findByRole('heading', { name: heading, level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByText('This screen is not built yet.')).toBeVisible()
    expect(locationText()).toBe(path)

    const main = screen.getByRole('main')
    expect(within(main).queryAllByRole('button')).toHaveLength(0)
    expect(within(main).queryAllByRole('link')).toHaveLength(0)
    expect(main).not.toHaveTextContent(/secret-id/)
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /sign out/i }),
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(profileMock.fetchProfileDisplayName).toHaveBeenCalledTimes(1)
      expect(profileMock.fetchProfileDisplayName).toHaveBeenCalledWith('user-1')
    })
  })

  it('renders /cycles/:id/feedback with the real feedback form, not a placeholder', async () => {
    renderSignedIn('/cycles/cycle-secret-id/feedback')

    expect(
      await screen.findByText('Cycle not found or you do not have access.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('This screen is not built yet.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Feedback', level: 1 }),
    ).not.toBeInTheDocument()
    expect(locationText()).toBe('/cycles/cycle-secret-id/feedback')
  })

  it('renders /projects and /projects/:id with the real projects screens, not placeholders', async () => {
    const first = renderSignedIn('/projects')
    expect(
      await screen.findByRole('heading', { name: 'Projects', level: 1 }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('This screen is not built yet.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Project' }),
    ).not.toBeInTheDocument()
    first.unmount()

    renderSignedIn('/projects/project-1')
    expect(
      await screen.findByText('Project not found or you do not have access.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Project', level: 1 }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('This screen is not built yet.'),
    ).not.toBeInTheDocument()
  })

  it('redirects a signed-in / to /projects', async () => {
    const navigationLog: string[] = []
    renderSignedIn('/', navigationLog)

    expect(
      await screen.findByRole('heading', { name: 'Projects' }),
    ).toBeInTheDocument()
    expect(locationText()).toBe('/projects')
    await waitFor(() => {
      expect(navigationLog).toContain('/projects')
    })
    expect(navigationLog).not.toContain('/login')
  })
})

describe('not-found route', () => {
  it.each(['/nope', '/cycles/abc/unknown', '/projects/abc/extra'])(
    'renders the in-shell not-found page for %s without redirecting',
    async (path) => {
      const navigationLog: string[] = []
      renderSignedIn(path, navigationLog)

      expect(
        await screen.findByRole('heading', { name: 'Page not found' }),
      ).toBeInTheDocument()
      expect(
        screen.getByText(
          'The page you requested does not exist or may have moved.',
        ),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('link', { name: 'Back to projects' }),
      ).toHaveAttribute('href', '/projects')
      expect(screen.getAllByRole('banner')).toHaveLength(1)
      expect(
        screen.getByRole('navigation', { name: 'Primary' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /Account menu/ }),
      ).toBeInTheDocument()

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(locationText()).toBe(path)
      expect(navigationLog).toEqual([path])
    },
  )

  it('sends a signed-out unmatched path through /login and back to not-found', async () => {
    mockEmptySession()
    const navigationLog: string[] = []

    renderApp({
      initialEntries: ['/cycles/abc/unknown?tab=old'],
      navigationLog,
    })

    await waitFor(() => {
      expect(locationText()).toBe(
        '/login?redirectTo=%2Fcycles%2Fabc%2Funknown%3Ftab%3Dold',
      )
    })

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
    })

    expect(
      await screen.findByRole('heading', { name: 'Page not found' }),
    ).toBeInTheDocument()
    expect(locationText()).toBe('/cycles/abc/unknown?tab=old')
    await waitFor(() => {
      expect(navigationLog).toContain('/cycles/abc/unknown?tab=old')
    })
    expect(navigationLog).not.toContain('/projects')
  })
})

describe('deep links', () => {
  it('renders a signed-in deep link immediately with its query preserved', async () => {
    const navigationLog: string[] = []
    renderSignedIn('/cycles/abc/board?mode=vote', navigationLog)

    expect(
      await screen.findByRole('heading', { name: 'Retrospective board' }),
    ).toBeInTheDocument()
    expect(locationText()).toBe('/cycles/abc/board?mode=vote')
    expect(navigationLog).not.toContain('/login')
    expect(navigationLog.some((entry) => entry.startsWith('/login'))).toBe(
      false,
    )
  })

  it('returns a signed-out deep link through /login to the same route and query', async () => {
    mockEmptySession()
    const navigationLog: string[] = []
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')

    renderApp({
      initialEntries: ['/cycles/abc/board?mode=vote'],
      navigationLog,
    })

    await waitFor(() => {
      expect(locationText()).toBe(
        '/login?redirectTo=%2Fcycles%2Fabc%2Fboard%3Fmode%3Dvote',
      )
    })
    await waitFor(() => {
      expect(navigationLog).toContain(
        '/login?redirectTo=%2Fcycles%2Fabc%2Fboard%3Fmode%3Dvote',
      )
    })

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
    })

    expect(
      await screen.findByRole('heading', { name: 'Retrospective board' }),
    ).toBeInTheDocument()
    expect(locationText()).toBe('/cycles/abc/board?mode=vote')
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(navigationLog).toContain('/cycles/abc/board?mode=vote')
    })
    expect(navigationLog).not.toContain('/projects')
  })
})
