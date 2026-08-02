import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makeLeaf, findLeaf } from '../../../../shared/paneTree'
import type { PaneLeaf, Tab } from '../../../../shared/types'
import { installMockIpc, type MockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'
import { isIdleAgentSuspensionEligible } from '../../store/idleAgentSuspension'
import { PaneHeader } from './index'

let ipc: MockIpc

beforeEach(() => {
  ipc = installMockIpc()
  useSettingsStore.setState({ showGitBranchBadges: false })
})

afterEach(() => {
  cleanup()
})

function plantPane(pane: PaneLeaf): Tab {
  const tab: Tab = {
    id: 'tab-1',
    rootNode: pane,
    focusedPaneId: pane.id,
    defaultCwd: pane.cwd,
  }
  usePanesStore.setState({ tabs: [tab], activeTabId: tab.id })
  return tab
}

describe('PaneHeader - presentation and actions', () => {
  it('shows the pane label and invokes folder opening with its cwd', async () => {
    const user = userEvent.setup()
    const pane = makeLeaf('C:\\work\\console')
    pane.customName = 'API'
    plantPane(pane)

    render(<PaneHeader pane={pane} isFocused />)

    expect(screen.getByText('API · console')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open in folder' }))
    expect(ipc.invoke).toHaveBeenCalledWith('shell:open-folder', 'C:\\work\\console')
  })

  it('zooms and unzooms through the real panes store', async () => {
    const user = userEvent.setup()
    const pane = makeLeaf('C:\\work')
    plantPane(pane)
    const { rerender } = render(<PaneHeader pane={pane} isFocused />)

    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    expect(usePanesStore.getState().zoomedPaneId).toBe(pane.id)

    rerender(<PaneHeader pane={pane} isFocused />)
    await user.click(screen.getByRole('button', { name: 'Unzoom' }))
    expect(usePanesStore.getState().zoomedPaneId).toBeNull()
  })

  it('commits a trimmed custom label on Enter', async () => {
    const user = userEvent.setup()
    const pane = makeLeaf('C:\\work\\console')
    const tab = plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)

    await user.dblClick(screen.getByTitle('Double-click to add a label'))
    const input = screen.getByPlaceholderText('Label (optional)')
    await user.type(input, '  Backend  ')
    await user.keyboard('{Enter}')

    const root = usePanesStore.getState().tabs.find((item) => item.id === tab.id)!.rootNode!
    expect(findLeaf(root, pane.id)?.customName).toBe('Backend')
  })

  it('copies the full agent session id from its abbreviated badge', async () => {
    const user = userEvent.setup()
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'codex'
    pane.sessionId = '12345678-full-session-id'
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)

    expect(screen.getByText('12345678')).toBeInTheDocument()
    await user.click(screen.getByTitle(/Session ID: 12345678-full-session-id/))

    expect(ipc.invoke).toHaveBeenCalledWith('shell:copy-to-clipboard', '12345678-full-session-id')
  })

  it('keeps the newly split pane focused when the menu click bubbles through the old tree', async () => {
    const user = userEvent.setup()
    const pane = makeLeaf('C:\\work')
    plantPane(pane)
    ipc.invoke.mockResolvedValue({ ptyId: 'new-agent-pty', sessionId: 'new-session' })

    render(
      <div onClick={() => usePanesStore.getState().focusPane(pane.id)}>
        <PaneHeader pane={pane} isFocused />
      </div>
    )

    await user.click(screen.getByRole('button', { name: 'Split pane' }))
    await user.click(screen.getAllByTitle(/Split horizontal/)[0])

    const tab = usePanesStore.getState().tabs[0]
    expect(tab.focusedPaneId).not.toBe(pane.id)
    expect(findLeaf(tab.rootNode!, tab.focusedPaneId)?.ptyId).toBe('new-agent-pty')
  })

  it('shows a status dot for an agent pane with the working tooltip (spec 032)', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'claude'
    pane.ptyId = 'pty-working'
    pane.agentStatus = { status: 'working', detail: 'Bash', event: 'pre_tool_use', updatedAt: 1 }
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)
    expect(screen.getByTitle('Working: Bash (includes thinking)')).toBeInTheDocument()
  })

  it('defaults an agent with no status object to idle when its PTY is live', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'claude'
    pane.ptyId = 'pty-live'
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)
    expect(screen.getByTitle('Idle')).toBeInTheDocument()
  })

  it('preserves an explicit unknown status for a live agent', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'claude'
    pane.ptyId = 'pty-live'
    pane.agentStatus = { status: 'unknown', updatedAt: 1 }
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)
    expect(screen.getByTitle('Status unknown')).toBeInTheDocument()
  })

  it.each(['claude', 'codex', 'opencode'] as const)('shows disconnected while a %s pane has no live PTY, without changing seeded idle state', (agentKind) => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = agentKind
    pane.agentStatus = { status: 'idle', updatedAt: 1 }
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)
    expect(screen.getByTitle('Disconnected')).toBeInTheDocument()
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument()
    expect(pane.agentStatus.status).toBe('idle')
    expect(isIdleAgentSuspensionEligible(pane)).toBe(false)
  })

  it.each(['', '   '])('treats a %j PTY ID as disconnected', (ptyId) => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'claude'
    pane.ptyId = ptyId
    pane.agentStatus = { status: 'idle', updatedAt: 1 }
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)
    expect(screen.getByTitle('Disconnected')).toBeInTheDocument()
  })

  it('keeps the normal lifecycle dot for a live idle agent pane', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'codex'
    pane.ptyId = 'pty-idle'
    pane.agentStatus = { status: 'idle', updatedAt: 1 }
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)
    expect(screen.getByTitle('Idle')).toBeInTheDocument()
  })

  it('shows the shared disconnected icon for policy-suspended panes', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'codex'
    pane.agentSuspension = { reason: 'idle-policy', at: 1 }
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)
    expect(screen.getByTitle('Disconnected')).toBeInTheDocument()
    expect(screen.queryByTitle('Status unknown')).not.toBeInTheDocument()
  })

  it('does not render a status dot for a shell pane (spec 032)', () => {
    const pane = makeLeaf('C:\\work')
    plantPane(pane)
    render(<PaneHeader pane={pane} isFocused />)
    expect(screen.queryByTitle('Status unknown')).not.toBeInTheDocument()
  })
})
