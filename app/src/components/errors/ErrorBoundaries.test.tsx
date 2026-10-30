import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { mockRestoredSession } from '../../test/authMock'
import { profileMock } from '../../test/profileMock'
import { renderApp } from '../../test/renderApp'

vi.mock('../../routes/Placeholders', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../routes/Placeholders')>()
  return {
    ...actual,
    ProjectPage: function ThrowingProjectPage(): never {
      throw new Error('route render failed')
    },
  }
})

vi.mock('../../auth/LoginPage', () => ({
  default: function ThrowingLoginPage(): never {
    throw new Error('root render failed')
  },
}))

function boundaryLogCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((call) => call[0] === '[app-error-boundary]')
}

function expectSafeLogPayload(calls: unknown[][]): void {
  expect(calls.length).toBeGreaterThanOrEqual(1)
  for (const call of calls) {
    expect(call).toHaveLength(3)
    expect(call[1]).toBeInstanceOf(Error)
    expect(typeof call[2]).toBe('string')
  }

  const payload = JSON.stringify(calls)
  expect(payload).not.toContain('test-access-token')
  expect(payload).not.toContain('test-refresh-token')
  expect(payload).not.toContain('dev@example.com')
  expect(payload).not.toContain('secret-query')
}

describe('route error boundary', () => {
  it('keeps the shell usable and clears the fallback after navigation', async () => {
    mockRestoredSession()
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderApp({ initialEntries: ['/projects/project-1?token=secret-query'] })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Something went wrong')
    expect(
      within(alert).getByRole('heading', { name: 'Something went wrong' }),
    ).toBeInTheDocument()
    expect(
      within(alert).getByRole('button', { name: 'Try again' }),
    ).toBeEnabled()
    expect(
      within(alert).getByRole('button', { name: 'Reload page' }),
    ).toBeEnabled()
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/projects/project-1?token=secret-query',
    )

    // The shell around the failed screen is intact and operable.
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main')).toContainElement(alert)
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    const menuTrigger = await screen.findByRole('button', {
      name: /Account menu/,
    })
    fireEvent.pointerDown(menuTrigger, { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(
      within(menu).getByRole('menuitem', { name: 'Sign out' }),
    ).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('link', { name: 'Weekly Feedback Tool' }))

    expect(
      await screen.findByRole('heading', { name: 'Projects' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/projects')
    expectSafeLogPayload(boundaryLogCalls(errorSpy))
  })
})

describe('root error boundary', () => {
  it('shows the full-page fallback instead of a blank page', async () => {
    mockRestoredSession()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderApp({ initialEntries: ['/login?token=secret-query'] })

    expect(
      await screen.findByRole('heading', { name: 'Something went wrong' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByText('Weekly Feedback Tool')).toBeInTheDocument()
    expect(
      screen.getByText(/An unexpected error stopped the app from loading/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Reload page' }),
    ).toBeInTheDocument()

    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Account menu/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()

    expectSafeLogPayload(boundaryLogCalls(errorSpy))
  })
})
