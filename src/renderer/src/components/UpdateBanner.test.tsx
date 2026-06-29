import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UpdateBanner } from './UpdateBanner'
import { useUpdaterStore } from '../store/updater'
import { useSettingsStore } from '../store/settings'
import { installMockIpc, type MockIpc } from '../../../../tests/mockIpc'
import type { UpdaterStatus } from '../../../shared/types'

// UpdateBanner is the tractable presentational target for the RTL toolchain:
// it reads two stores and branches on status.state, with buttons that fire
// window.ipc. We render against the REAL stores (auto-reset between tests) and a
// fresh mockIpc per test to assert outbound calls.
//
// RTL auto-cleanup relies on a GLOBAL afterEach, but this project runs with
// vitest globals OFF (tests import `afterEach` explicitly), so we clean up
// manually — otherwise banners accumulate across tests and queries match many.

let ipc: MockIpc

beforeEach(() => {
  ipc = installMockIpc()
  // auto-reset mock restores store defaults (status: null, dismissed: false,
  // autoUpdateEnabled: false) after each test.
})

afterEach(() => {
  cleanup()
})

function setStatus(status: UpdaterStatus): void {
  useUpdaterStore.setState({ status, dismissed: false })
}

describe('UpdateBanner — rendering gates', () => {
  it('renders nothing when there is no status', () => {
    render(<UpdateBanner />)
    expect(screen.queryByText(/Update/)).toBeNull()
  })

  it('renders nothing for up-to-date / error states', () => {
    setStatus({ state: 'up-to-date' })
    const { unmount } = render(<UpdateBanner />)
    expect(screen.queryByText(/Update/)).toBeNull()
    unmount()

    setStatus({ state: 'error' })
    render(<UpdateBanner />)
    expect(screen.queryByText(/Update/)).toBeNull()
  })

  it('renders nothing once dismissed', () => {
    setStatus({ state: 'available', version: '1.2.3' })
    useUpdaterStore.getState().dismiss()
    render(<UpdateBanner />)
    expect(screen.queryByText(/Update/)).toBeNull()
  })
})

describe('UpdateBanner — available state', () => {
  it('shows the version and a Download button when auto-update is off', () => {
    setStatus({ state: 'available', version: '1.2.3' })
    render(<UpdateBanner />)
    expect(screen.getByText(/Update v1\.2\.3 available/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
  })

  it('hides the Download button when auto-update is enabled', () => {
    useSettingsStore.setState({ autoUpdateEnabled: true })
    setStatus({ state: 'available', version: '1.2.3' })
    render(<UpdateBanner />)
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('fires updater:download when Download is clicked', () => {
    setStatus({ state: 'available', version: '1.2.3' })
    render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(ipc.send).toHaveBeenCalledWith('updater:download')
  })
})

describe('UpdateBanner — ready / progress states', () => {
  it('shows Restart + Dismiss in the ready state', () => {
    setStatus({ state: 'ready', version: '2.0.0' })
    render(<UpdateBanner />)
    expect(screen.getByText(/Update v2\.0\.0 ready to install/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart to install' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('fires updater:install when Restart is clicked', () => {
    setStatus({ state: 'ready', version: '2.0.0' })
    render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }))
    expect(ipc.send).toHaveBeenCalledWith('updater:install')
  })

  it('reports download progress', () => {
    setStatus({ state: 'downloading', percent: 42 })
    render(<UpdateBanner />)
    expect(screen.getByText(/Downloading update… 42%/)).toBeInTheDocument()
  })

  it('marks the banner dismissed when Dismiss is clicked', () => {
    setStatus({ state: 'ready', version: '2.0.0' })
    render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useUpdaterStore.getState().dismissed).toBe(true)
  })
})
