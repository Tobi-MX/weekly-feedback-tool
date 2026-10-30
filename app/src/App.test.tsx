import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

// Keep this test independent from any local app/.env.local: the status check
// is covered separately in BackendStatus.test.tsx with a mocked fetch.
vi.mock('./env', () => ({
  getEnvConfig: () => ({ status: 'not-configured' }),
}))

describe('App', () => {
  it('renders the app heading', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'Weekly Feedback Tool' }),
    ).toBeInTheDocument()
  })
})
