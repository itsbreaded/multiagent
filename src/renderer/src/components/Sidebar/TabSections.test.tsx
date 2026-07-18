import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeLeaf } from '../../../../shared/paneTree'
import type { PaneLeaf, Tab } from '../../../../shared/types'
import { installMockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'
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
    pane.agentStatus = { status: 'working', detail: 'Bash', event: 'pre_tool_use', updatedAt: 1 }
    plantPane(pane)

    render(<TabSections />)

    expect(screen.getByTitle('Working: Bash (includes thinking)')).toBeInTheDocument()
  })

  it('renders the honest unknown dot for an agent pane with no hook events yet', () => {
    const pane = makeLeaf('C:\\work')
    pane.paneType = 'agent'
    pane.agentKind = 'codex'
    plantPane(pane)

    render(<TabSections />)

    expect(screen.getByTitle('Status unknown')).toBeInTheDocument()
  })

  it('does not render a status dot for a shell pane', () => {
    const pane = makeLeaf('C:\\work')
    plantPane(pane)

    render(<TabSections />)

    expect(screen.queryByTitle('Status unknown')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Working (includes thinking)')).not.toBeInTheDocument()
  })
})