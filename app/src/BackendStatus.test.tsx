import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import BackendStatus from './BackendStatus'

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

const SUPABASE_URL = 'http://127.0.0.1:54321'
const ANON_KEY = 'test-anon-key'

let fetchMock: Mock<FetchLike>

// Stub the real Vite environment instead of mocking ./env so these tests
// exercise the actual URL validation in parseEnvConfig.
function configure(url = SUPABASE_URL, anonKey = ANON_KEY): void {
  vi.stubEnv('VITE_SUPABASE_URL', url)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', anonKey)
}

function respondWith(status: number): void {
  fetchMock.mockResolvedValue(new Response(null, { status }))
}

function statusRegion(): HTMLElement {
  return screen.getByRole('status')
}

beforeEach(() => {
  configure()
  fetchMock = vi.fn<FetchLike>()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BackendStatus', () => {
  it('shows Not configured without requesting when both values are missing', () => {
    configure('', '')

    render(<BackendStatus />)

    expect(statusRegion()).toHaveTextContent('Not configured')
    expect(screen.getByText(/app\/\.env\.example/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows Not configured without requesting when the anon key is missing', () => {
    configure(SUPABASE_URL, '')

    render(<BackendStatus />)

    expect(statusRegion()).toHaveTextContent('Not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows Checking… while the request is in flight', () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}))

    render(<BackendStatus />)

    expect(statusRegion()).toHaveTextContent('Checking…')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows Connected on a 2xx response', async () => {
    respondWith(200)

    render(<BackendStatus />)

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Connected')
    })
  })

  it('requests /rest/v1/ with the anon key in both headers', async () => {
    respondWith(200)

    render(<BackendStatus />)

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Connected')
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0]
    expect(input).toBe('http://127.0.0.1:54321/rest/v1/')
    expect(init?.headers).toEqual({
      apikey: 'test-anon-key',
      Authorization: 'Bearer test-anon-key',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('shows Unreachable for a wrong anon key (401) without exposing the key', async () => {
    respondWith(401)

    render(<BackendStatus />)

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Unreachable')
    })
    expect(statusRegion()).not.toHaveTextContent('test-anon-key')
    expect(screen.getByText(/Could not reach/)).not.toHaveTextContent(
      'test-anon-key',
    )
  })

  it('shows Unreachable on any non-2xx response', async () => {
    respondWith(500)

    render(<BackendStatus />)

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Unreachable')
    })
  })

  it('shows Unreachable on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    render(<BackendStatus />)

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Unreachable')
    })
  })

  it('shows Unreachable for a relative URL without sending a request', () => {
    configure('not a valid url')

    render(<BackendStatus />)

    expect(statusRegion()).toHaveTextContent('Unreachable')
    expect(screen.getByText(/must be an absolute/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows Unreachable for a non-HTTP URL without sending a request', () => {
    configure('ftp://example.test')

    render(<BackendStatus />)

    expect(statusRegion()).toHaveTextContent('Unreachable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts after 5 seconds and shows Unreachable', async () => {
    vi.useFakeTimers()
    const onAbort = vi.fn()
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            onAbort()
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    )

    render(<BackendStatus />)

    expect(statusRegion()).toHaveTextContent('Checking…')
    expect(onAbort).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(statusRegion()).toHaveTextContent('Unreachable')
  })

  it('retries on click, disables Retry while in flight, and connects without a reload', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    render(<BackendStatus />)

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Unreachable')
    })

    const retryButton = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(retryButton)

    expect(statusRegion()).toHaveTextContent('Checking…')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Connected')
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight check on unmount without an unhandled rejection', async () => {
    const onAbort = vi.fn()
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            onAbort()
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    )

    const { unmount } = render(<BackendStatus />)
    unmount()

    expect(onAbort).toHaveBeenCalledTimes(1)
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('does not poll or auto-retry after a successful check', async () => {
    respondWith(200)

    render(<BackendStatus />)

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Connected')
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
