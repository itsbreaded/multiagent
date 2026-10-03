import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { usePanesStore } from '../../store/panes'
import { installMockIpc } from '../../../../../tests/mockIpc'
import { CommandPalette } from './index'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.homeDir = 'C:\\home'
})

afterEach(() => {
  cleanup()
})

describe('CommandPalette - filtering and enabled gates', () => {
  it('focuses the search input and filters by command keywords', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = screen.getByPlaceholderText('Search commands…')

    expect(input).toHaveFocus()
    await user.type(input, 'preferences')

    expect(screen.getByText('Open Settings')).toBeInTheDocument()
    expect(screen.getByText('Settings: Appearance')).toBeInTheDocument()
    expect(screen.queryByText('New Shell Pane')).toBeNull()
  })

  it('shows an empty state when no command matches', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.type(screen.getByPlaceholderText('Search commands…'), 'not-a-real-command')

    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('resets query and selection when a new owner instance mounts', async () => {
    const user = userEvent.setup()
    const mounted = render(<CommandPalette />)
    await user.type(screen.getByPlaceholderText('Search commands…'), 'preferences')
    expect(screen.getByText('Open Settings')).toBeInTheDocument()

    mounted.unmount()
    render(<CommandPalette />)

    expect(screen.getByPlaceholderText('Search commands…')).toHaveValue('')
    expect(screen.getByText('New Shell Pane')).toBeInTheDocument()
  })

  it('does not offer focused-pane commands when no pane is focused', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.type(screen.getByPlaceholderText('Search commands…'), 'Close Pane')

    expect(screen.queryByText('Close Pane')).toBeNull()
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('offers window-local settings and session commands in a detached window', async () => {
    const user = userEvent.setup()
    usePanesStore.setState({ isDetachedWindow: true })
    render(<CommandPalette />)

    await user.type(screen.getByPlaceholderText('Search commands…'), 'Open Settings')

    expect(screen.getByText('Open Settings')).toBeInTheDocument()

    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Session Browser')
    expect(screen.getByText('Open Session Browser')).toBeInTheDocument()
  })
})

describe('CommandPalette - interaction', () => {
  it('runs the selected command with Enter and closes the palette', async () => {
    const user = userEvent.setup()
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'overlay:request'
      ? { status: 'opened', kind: 'settings', ownerWindowId: 1, generation: 2, requestToken: 2, settingsSection: null }
      : undefined)
    usePanesStore.setState({ commandPaletteOpen: true, activeOverlayKind: 'command-palette', activeOverlayGeneration: 1, windowId: 1 })
    render(<CommandPalette />)

    await user.type(screen.getByPlaceholderText('Search commands…'), 'Open Settings')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      const state = usePanesStore.getState()
      expect(state.settingsOpen).toBe(true)
      expect(state.commandPaletteOpen).toBe(false)
    })
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    usePanesStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)

    await user.keyboard('{Escape}')

    expect(usePanesStore.getState().commandPaletteOpen).toBe(false)
  })
})
