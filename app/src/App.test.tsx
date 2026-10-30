import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

// Keep this test independent from any local app/.env.local: the status check
// is covered separately in BackendStatus.test.tsx with a mocked fetch.
vi.mock('./env', () => ({
  getEnvConfig: () => ({ status: 'not-configured' }),
}))

describe('App', () => {
  it('renders the app heading and the backend status', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    expect(
      screen.getByRole('heading', { name: 'Weekly Feedback Tool' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/Backend status: Not configured/),
    ).toBeInTheDocument()
  })
})
