import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary, logBoundaryError } from './AppErrorBoundary'

function boundaryLogCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((call) => call[0] === '[app-error-boundary]')
}

describe('AppErrorBoundary', () => {
  it('renders the fallback and logs only the error and component stack', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    function Boom(): never {
      throw new Error('render boom')
    }

    render(
      <AppErrorBoundary
        fallback={({ reset }) => (
          <div>
            <h1>Fallback</h1>
            <button type="button" onClick={reset}>
              Try again
            </button>
          </div>
        )}
      >
        <Boom />
      </AppErrorBoundary>,
    )

    expect(
      screen.getByRole('heading', { name: 'Fallback' }),
    ).toBeInTheDocument()

    const calls = boundaryLogCalls(errorSpy)
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toBeInstanceOf(Error)
    expect((calls[0][1] as Error).message).toBe('render boom')
    expect(typeof calls[0][2]).toBe('string')
    expect(calls[0]).toHaveLength(3)

    const payload = JSON.stringify(calls)
    expect(payload).not.toContain('test-access-token')
    expect(payload).not.toContain('test-refresh-token')
    expect(payload).not.toContain('dev@example.com')
    expect(payload).not.toContain('secret-query')
  })

  it('resets and renders the children again after the cause is fixed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let shouldThrow = true

    function Flaky() {
      if (shouldThrow) {
        throw new Error('recoverable')
      }
      return <p>Recovered</p>
    }

    render(
      <AppErrorBoundary
        fallback={({ reset }) => (
          <button type="button" onClick={reset}>
            Try again
          </button>
        )}
      >
        <Flaky />
      </AppErrorBoundary>,
    )

    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument()

    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('Recovered')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Try again' }),
    ).not.toBeInTheDocument()
  })

  it('passes exactly the error and stack to the log sink', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('direct log')

    logBoundaryError(error, ' at SecretScreen')

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '[app-error-boundary]',
      error,
      ' at SecretScreen',
    )
  })
})
