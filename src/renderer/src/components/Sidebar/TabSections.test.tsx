import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeLeaf } from '../../../../shared/paneTree'
import type { PaneLeaf, Tab } from '../../../../shared/types'
import { installMockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'
import { isIdleAgentSuspensionEligible } from '../../store/idleAgentSuspension'
import { TabSections } from './TabSections'

beforeEach(() => {
  installMockIpc()
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

describe('TabSections - agent status dot (spec 032)', () => {
  it('renders the live status dot for an agent pane with a working status', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'claude'
    pane.ptyId = 'pty-working'
    pane.agentStatus = { status: 'working', detail: 'Bash', event: 'pre_tool_use', updatedAt: 1 }
    plantPane(pane)

    render(<TabSections />)

    expect(screen.getByTitle('Working: Bash (includes thinking)')).toBeInTheDocument()
  })

  it('defaults a live agent with no status object to idle', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'codex'
    pane.ptyId = 'pty-live'
    plantPane(pane)
    render(<TabSections />)
    expect(screen.getByTitle('Idle')).toBeInTheDocument()
  })

  it('preserves an explicit unknown status for a live agent', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'codex'
    pane.ptyId = 'pty-live'
    pane.agentStatus = { status: 'unknown', updatedAt: 1 }
    plantPane(pane)
    render(<TabSections />)
    expect(screen.getByTitle('Status unknown')).toBeInTheDocument()
  })

  it.each(['claude', 'codex', 'opencode'] as const)('renders disconnected for an unhydrated %s pane while retaining seeded idle state', (agentKind) => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = agentKind
    pane.agentStatus = { status: 'idle', updatedAt: 1 }
    plantPane(pane)

    render(<TabSections />)

    expect(screen.getByTitle('Disconnected')).toBeInTheDocument()
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument()
    expect(pane.agentStatus.status).toBe('idle')
    expect(isIdleAgentSuspensionEligible(pane)).toBe(false)
  })

  it('renders the normal idle dot when an agent has a live PTY', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'codex'
    pane.ptyId = 'pty-idle'
    pane.agentStatus = { status: 'idle', updatedAt: 1 }
    plantPane(pane)

    render(<TabSections />)

    expect(screen.getByTitle('Idle')).toBeInTheDocument()
  })

  it('uses the disconnected icon for an unexpectedly disconnected agent', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'claude'
    pane.agentDisconnected = { exitCode: 0, at: 1 }
    plantPane(pane)
    render(<TabSections />)
    expect(screen.getByTitle('Disconnected')).toBeInTheDocument()
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument()
  })

  it('keeps stale-PTY intentional suspension disconnected', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'opencode'
    pane.ptyId = 'stale-pty'
    pane.agentSuspension = { reason: 'idle-policy', at: 1 }
    plantPane(pane)

    render(<TabSections />)

    expect(screen.getByTitle('Disconnected')).toBeInTheDocument()
  })

  it('does not render a status dot for a shell pane', () => {
    const pane = makeLeaf('C:\\work')
    plantPane(pane)

    render(<TabSections />)

    expect(screen.queryByTitle('Status unknown')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Working (includes thinking)')).not.toBeInTheDocument()
  })
})
