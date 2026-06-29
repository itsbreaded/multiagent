import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makeLeaf, findLeaf } from '../../../../shared/paneTree'
import type { PaneLeaf, Tab } from '../../../../shared/types'
import { installMockIpc, type MockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'
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
})
