import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import {
  authMock,
  mockEmptySession,
  mockRestoredSession,
} from '../test/authMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'

vi.mock('../projects/ProjectsPage', async () => {
  const React = await import('react')
  const { toast } = await import('sonner')
  const { Link } = await import('react-router-dom')

  function ToastProbePage() {
    React.useEffect(() => {
      toast.success('Route toast')
    }, [])

    return (
      <section>
        <h1>Projects</h1>
        <Link to="/projects/project-1">Open project</Link>
      </section>
    )
  }

  return { default: ToastProbePage }
})

function toastViewports(): NodeListOf<Element> {
  return document.querySelectorAll('[data-sonner-toaster]')
}

async function renderSignedIn(path: string) {
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  return renderApp({ initialEntries: [path] })
}

describe('Toaster', () => {
  it('mounts exactly one toast viewport on signed-in and public screens', async () => {
    const first = await renderSignedIn('/projects')
    await screen.findByRole('heading', { name: 'Projects' })
    expect(toastViewports()).toHaveLength(1)
    first.unmount()

    const second = await renderSignedIn('/projects/project-1')
    await screen.findByText('Project not found or you do not have access.')
    expect(toastViewports()).toHaveLength(1)
    second.unmount()

    mockEmptySession()
    renderApp({ initialEntries: ['/login'] })
    await screen.findByLabelText('Email')
    expect(toastViewports()).toHaveLength(1)
  })

  it('shows a toast raised by a routed component and keeps it across navigation', async () => {
    await renderSignedIn('/projects')

    expect(await screen.findByText('Route toast')).toBeVisible()
    expect(toastViewports()).toHaveLength(1)

    fireEvent.click(screen.getByRole('link', { name: 'Open project' }))

    expect(
      await screen.findByText('Project not found or you do not have access.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Route toast')).toBeVisible()
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/projects/project-1',
    )
    expect(toastViewports()).toHaveLength(1)
  })

  it('does not steal focus or block the login form', async () => {
    mockEmptySession()
    authMock.signInWithOtp.mockResolvedValue({ error: null })

    renderApp({ initialEntries: ['/login'] })

    const input = await screen.findByLabelText<HTMLInputElement>('Email')
    input.focus()
    expect(input).toHaveFocus()

    act(() => {
      toast.success('Background message')
    })

    expect(await screen.findByText('Background message')).toBeVisible()
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: 'dev@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }))

    await waitFor(() => {
      expect(authMock.signInWithOtp).toHaveBeenCalledTimes(1)
    })
    expect(document.getElementById('login-status')).toHaveTextContent(
      'Check your email for a sign-in link.',
    )
    expect(screen.getByText('Background message')).toBeVisible()
  })
})
