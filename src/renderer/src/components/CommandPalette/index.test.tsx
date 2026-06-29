import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { usePanesStore } from '../../store/panes'
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

  it('does not offer focused-pane commands when no pane is focused', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.type(screen.getByPlaceholderText('Search commands…'), 'Close Pane')

    expect(screen.queryByText('Close Pane')).toBeNull()
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('hides main-window-only commands in a detached window', async () => {
    const user = userEvent.setup()
    usePanesStore.setState({ isDetachedWindow: true })
    render(<CommandPalette />)

    await user.type(screen.getByPlaceholderText('Search commands…'), 'Open Settings')

    expect(screen.queryByText('Open Settings')).toBeNull()
    expect(screen.getByText('No results')).toBeInTheDocument()
  })
})

describe('CommandPalette - interaction', () => {
  it('runs the selected command with Enter and closes the palette', async () => {
    const user = userEvent.setup()
    usePanesStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)

    await user.type(screen.getByPlaceholderText('Search commands…'), 'Open Settings')
    await user.keyboard('{Enter}')

    const state = usePanesStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.commandPaletteOpen).toBe(false)
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    usePanesStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)

    await user.keyboard('{Escape}')

    expect(usePanesStore.getState().commandPaletteOpen).toBe(false)
  })
})
