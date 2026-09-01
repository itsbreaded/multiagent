import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

function tabWithLabel(id: string, label: string, detached = false): Tab {
  const pane = makeLeaf(`C:\\${id}`)
  return {
    id,
    customLabel: label,
    rootNode: pane,
    focusedPaneId: pane.id,
    detached,
  }
}

function tabHeader(label: string): HTMLElement {
  return screen.getByRole('button', { name: label }).parentElement!
}

function tabDataTransfer(): DataTransfer {
  const values = new Map<string, string>()
  const types: string[] = []
  return {
    types,
    setData: (type: string, value: string) => {
      values.set(type, value)
      if (!types.includes(type)) types.push(type)
    },
    getData: (type: string) => values.get(type) ?? '',
    effectAllowed: 'none',
    dropEffect: 'none',
  } as unknown as DataTransfer
}

function dispatchTabDrag(element: HTMLElement, type: 'dragover' | 'drop', dataTransfer: DataTransfer, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientY: { value: clientY },
  })
  element.dispatchEvent(event)
  return event
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

describe('TabSections - detached tab reorder', () => {
  it('allows local and detached tabs to reorder through the same sidebar flow', () => {
    const localBefore = tabWithLabel('local-before', 'Local before')
    const detached = tabWithLabel('detached', 'Detached', true)
    const localAfter = tabWithLabel('local-after', 'Local after')
    usePanesStore.setState({
      tabs: [localBefore, detached, localAfter],
      activeTabId: localBefore.id,
      detachedWindowTabIds: {},
      detachedWindowActiveTabIds: {},
    })

    render(<TabSections />)

    const detachedHeader = tabHeader('Detached')
    expect(detachedHeader).toHaveAttribute('draggable', 'true')

    const localAfterTransfer = tabDataTransfer()
    fireEvent.dragStart(tabHeader('Local after'), { dataTransfer: localAfterTransfer })
    expect(localAfterTransfer.types).toContain('application/x-multiagent-tab-reorder')
    expect(localAfterTransfer.getData('application/x-multiagent-tab-reorder')).toBe(JSON.stringify({ tabId: localAfter.id }))
    let dragOverEvent!: Event
    act(() => {
      dragOverEvent = dispatchTabDrag(detachedHeader, 'dragover', localAfterTransfer, -1)
    })
    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(detachedHeader.style.boxShadow).not.toBe('none')
    act(() => {
      dispatchTabDrag(detachedHeader, 'drop', localAfterTransfer, -1)
    })
    expect(usePanesStore.getState().tabs.map((tab) => tab.id)).toEqual([
      localBefore.id,
      localAfter.id,
      detached.id,
    ])

    const detachedTransfer = tabDataTransfer()
    fireEvent.dragStart(tabHeader('Detached'), { dataTransfer: detachedTransfer })
    const localBeforeHeader = tabHeader('Local before')
    act(() => {
      dispatchTabDrag(localBeforeHeader, 'dragover', detachedTransfer, -1)
    })
    act(() => {
      dispatchTabDrag(localBeforeHeader, 'drop', detachedTransfer, -1)
    })
    expect(usePanesStore.getState().tabs.map((tab) => tab.id)).toEqual([
      detached.id,
      localBefore.id,
      localAfter.id,
    ])
  })
})
