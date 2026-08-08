import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TerminalHostRecoveryBanner } from './TerminalHostRecoveryBanner'
import { useTerminalHostStore } from '../store/terminalHost'
import { installMockIpc, type MockIpc } from '../../../../tests/mockIpc'

let ipc: MockIpc

beforeEach(() => {
  ipc = installMockIpc()
  useTerminalHostStore.setState({ status: null })
})

afterEach(() => cleanup())

describe('TerminalHostRecoveryBanner', () => {
  it('renders recovery progress without offering a restart', () => {
    useTerminalHostStore.setState({
      status: {
        state: 'recovering', incidentId: 'incident-1', code: 1,
        affectedPtyIds: [], unreadyPtyIds: [], unreadyNewAgentPtyIds: [],
      },
    })
    render(<TerminalHostRecoveryBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('Restoring your terminals')
    expect(screen.queryByRole('button', { name: 'Restart MultiAgent' })).toBeNull()
  })

  it('offers an explicit application restart after recovery fails', async () => {
    useTerminalHostStore.setState({
      status: {
        state: 'failed', incidentId: 'incident-1', code: 7, message: 'spawn failed',
        affectedPtyIds: [], unreadyPtyIds: [], unreadyNewAgentPtyIds: [],
      },
    })
    render(<TerminalHostRecoveryBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart MultiAgent' }))
    expect(ipc.invoke).toHaveBeenCalledWith('app:restart')
  })
})
