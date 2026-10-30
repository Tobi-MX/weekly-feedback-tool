import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { authMock } from './test/authMock'

// Keep this test independent from any local app/.env.local: the status check
// is covered separately in BackendStatus.test.tsx with a mocked fetch.
vi.mock('./env', () => ({
  getEnvConfig: () => ({ status: 'not-configured' }),
}))

describe('App', () => {
  it('renders the product name and backend status in the public layout', async () => {
    authMock.isSupabaseConfigured = false

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole('link', { name: 'Weekly Feedback Tool' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/Backend status: Not configured/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Sign-in is not configured' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
  })
})
