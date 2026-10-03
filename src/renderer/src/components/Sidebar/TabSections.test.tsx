import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeLeaf } from '../../../../shared/paneTree'
import type { PaneLeaf, Tab } from '../../../../shared/types'
import { installMockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'
import { useJiraStore } from '../../store/jira'
import { isIdleAgentSuspensionEligible } from '../../store/idleAgentSuspension'
import { TabSections } from './TabSections'
import { TAB_DRAG_MIME } from '../../utils/tabDrag'

const TEST_BASE_URL = 'https://jira.example.com'

beforeEach(() => {
  installMockIpc()
  useSettingsStore.setState({ showGitBranchBadges: false })
  useJiraStore.setState({
    settings: { baseUrl: TEST_BASE_URL, email: '', patterns: [], hasToken: false },
    hydrated: false,
    configVersion: 0,
    labels: {},
    projects: {},
    rows: {},
    suppressedInitialTabs: {},
  })
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

describe('TabSections - ownership-scoped reorder', () => {
  it('hides detached proxies and reorders only visible local tabs', () => {
    const localBefore = tabWithLabel('local-before', 'Local before')
    const detached = tabWithLabel('detached', 'Detached', true)
    const localAfter = tabWithLabel('local-after', 'Local after')
    usePanesStore.setState({
      tabs: [localBefore, detached, localAfter],
      activeTabId: localBefore.id,
      detachedWindowTabIds: {},
      detachedWindowActiveTabIds: {},
      isDetachedWindow: false,
    })

    render(<TabSections />)

    expect(screen.queryByRole('button', { name: 'Detached' })).toBeNull()

    const localAfterTransfer = tabDataTransfer()
    fireEvent.dragStart(tabHeader('Local after'), { dataTransfer: localAfterTransfer })
    expect(localAfterTransfer.types).toContain('application/x-multiagent-tab-reorder')
    expect(localAfterTransfer.getData('application/x-multiagent-tab-reorder')).toBe(JSON.stringify({ tabId: localAfter.id }))
    let dragOverEvent!: Event
    act(() => { dragOverEvent = dispatchTabDrag(tabHeader('Local before'), 'dragover', localAfterTransfer, -1) })
    expect(dragOverEvent.defaultPrevented).toBe(true)
    act(() => { dispatchTabDrag(tabHeader('Local before'), 'drop', localAfterTransfer, -1) })
    expect(usePanesStore.getState().tabs.map((tab) => tab.id)).toEqual([
      localAfter.id,
      detached.id,
      localBefore.id,
    ])
  })

  it('treats the space below the sidebar sections as an append target', () => {
    const first = tabWithLabel('first-tab', 'First tab')
    const second = tabWithLabel('second-tab', 'Second tab')
    const third = tabWithLabel('third-tab', 'Third tab')
    usePanesStore.setState({
      tabs: [first, second, third],
      activeTabId: first.id,
      isDetachedWindow: false,
      windowId: 1,
    })

    render(<TabSections />)
    const transfer = tabDataTransfer()
    fireEvent.dragStart(tabHeader('First tab'), { dataTransfer: transfer })
    const container = document.querySelector('[data-sidebar-tab-container="true"]') as HTMLElement

    let dragOverEvent!: Event
    act(() => { dragOverEvent = dispatchTabDrag(container, 'dragover', transfer, 9999) })
    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(transfer.dropEffect).toBe('move')
    expect(container.querySelector('[data-sidebar-insertion-edge="bottom"]')).not.toBeNull()
    act(() => { dispatchTabDrag(container, 'drop', transfer, 9999) })

    expect(usePanesStore.getState().tabs.map((tab) => tab.id)).toEqual([
      second.id,
      third.id,
      first.id,
    ])
  })

  it('treats a section body as the insertion point immediately after that tab', () => {
    const first = tabWithLabel('first-tab', 'First tab')
    const second = tabWithLabel('second-tab', 'Second tab')
    const third = tabWithLabel('third-tab', 'Third tab')
    usePanesStore.setState({
      tabs: [first, second, third],
      activeTabId: first.id,
      isDetachedWindow: false,
      windowId: 1,
    })

    render(<TabSections />)
    const transfer = tabDataTransfer()
    fireEvent.dragStart(tabHeader('Third tab'), { dataTransfer: transfer })
    const firstSection = tabHeader('First tab').parentElement as HTMLElement

    let sectionDragOver!: Event
    act(() => { sectionDragOver = dispatchTabDrag(firstSection, 'dragover', transfer, 9999) })
    expect(sectionDragOver.defaultPrevented).toBe(true)
    expect(firstSection.querySelector('[data-sidebar-insertion-edge="bottom"]')).not.toBeNull()
    let sectionDrop!: Event
    act(() => { sectionDrop = dispatchTabDrag(firstSection, 'drop', transfer, 9999) })
    expect(sectionDrop.defaultPrevented).toBe(true)

    expect(usePanesStore.getState().tabs.map((tab) => tab.id)).toEqual([
      first.id,
      third.id,
      second.id,
    ])
  })

  it('resolves the background gap between sections to the following section', () => {
    const first = tabWithLabel('first-tab', 'First tab')
    const second = tabWithLabel('second-tab', 'Second tab')
    const third = tabWithLabel('third-tab', 'Third tab')
    usePanesStore.setState({
      tabs: [first, second, third],
      activeTabId: first.id,
      isDetachedWindow: false,
      windowId: 1,
    })

    render(<TabSections />)
    const transfer = tabDataTransfer()
    fireEvent.dragStart(tabHeader('Third tab'), { dataTransfer: transfer })
    const container = document.querySelector('[data-sidebar-tab-container="true"]') as HTMLElement
    const sectionBounds = [
      { top: 0, bottom: 80 },
      { top: 120, bottom: 200 },
      { top: 240, bottom: 320 },
    ]
    Array.from(container.children).forEach((section, index) => {
      const bounds = sectionBounds[index]
      Object.defineProperty(section, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: bounds.top, bottom: bounds.bottom, height: bounds.bottom - bounds.top } as DOMRect),
      })
    })

    act(() => { dispatchTabDrag(container, 'dragover', transfer, 100) })
    expect(container.children[0].querySelector('[data-sidebar-insertion-edge="bottom"]')).not.toBeNull()
    act(() => { dispatchTabDrag(container, 'drop', transfer, 100) })

    expect(usePanesStore.getState().tabs.map((tab) => tab.id)).toEqual([
      first.id,
      third.id,
      second.id,
    ])
  })

  it('sends a cross-window tab drop through the absorb protocol', () => {
    const ipc = installMockIpc()
    const target = tabWithLabel('target-tab', 'Target tab')
    const incoming = tabWithLabel('incoming-tab', 'Incoming tab')
    const pane = incoming.rootNode as PaneLeaf
    pane.ptyId = 'pty-incoming'
    usePanesStore.setState({
      tabs: [target],
      activeTabId: target.id,
      isDetachedWindow: false,
      windowId: 22,
    })

    render(<TabSections />)
    const transfer = tabDataTransfer()
    transfer.setData(TAB_DRAG_MIME, JSON.stringify({ tab: incoming, ptyIds: ['pty-incoming'], sourceWindowId: 11 }))
    act(() => { dispatchTabDrag(tabHeader('Target tab'), 'dragover', transfer, 1) })
    act(() => { dispatchTabDrag(tabHeader('Target tab'), 'drop', transfer, 1) })

    expect(ipc.invoke).toHaveBeenCalledWith('window:focus')
    expect(ipc.invoke).toHaveBeenCalledWith(
      'tab:absorb',
      JSON.stringify(incoming),
      ['pty-incoming'],
      11,
      1,
    )
  })

  it('starts a tear-off at the native drag end location when dropped outside windows', async () => {
    const ipc = installMockIpc()
    const tab = tabWithLabel('tear-off-tab', 'Tear off tab')
    usePanesStore.setState({ tabs: [tab], activeTabId: tab.id, isDetachedWindow: false, windowId: 11 })

    render(<TabSections />)
    const transfer = tabDataTransfer()
    fireEvent.dragStart(tabHeader('Tear off tab'), { dataTransfer: transfer })
    const dragEnd = new Event('dragend', { bubbles: true, cancelable: true })
    Object.defineProperties(dragEnd, {
      dataTransfer: { value: transfer },
      screenX: { value: 1800 },
      screenY: { value: 420 },
    })
    tabHeader('Tear off tab').dispatchEvent(dragEnd)
    await act(async () => { await Promise.resolve() })

    const tearOff = ipc.invoke.mock.calls.find((call: unknown[]) => call[0] === 'tab:tear-off')
    expect(tearOff?.[3]).toBe(1800)
    expect(tearOff?.[4]).toBe(420)
    expect(usePanesStore.getState().tabs).toHaveLength(1)
  })
})

describe('TabSections - sidebar tab actions', () => {
  it('activates a tab selected from the sidebar', () => {
    const first = tabWithLabel('first-tab', 'First tab')
    const second = tabWithLabel('second-tab', 'Second tab')
    usePanesStore.setState({ tabs: [first, second], activeTabId: first.id, isDetachedWindow: false })

    render(<TabSections />)
    fireEvent.click(screen.getByRole('button', { name: 'Second tab' }))

    expect(usePanesStore.getState().activeTabId).toBe(second.id)
  })

  it('keeps individual actions and movement while removing duplicate/bulk-close actions', () => {
    const tab = tabWithLabel('local-tab', 'Local tab')
    usePanesStore.setState({ tabs: [tab], activeTabId: tab.id, isDetachedWindow: false })

    render(<TabSections />)
    fireEvent.contextMenu(tabHeader('Local tab'))

    expect(screen.getByText('Move Tab to New Window')).toBeInTheDocument()
    expect(screen.getByText('Rename')).toBeInTheDocument()
    expect(screen.getByText('Close tab')).toBeInTheDocument()
    expect(screen.queryByText('Duplicate Tab')).toBeNull()
    expect(screen.queryByText('Close Other Tabs')).toBeNull()
    expect(screen.queryByText('Close Tabs to the Right')).toBeNull()
  })

  it('offers return to the main window for a detached tab', () => {
    const ipc = installMockIpc()
    const tab = tabWithLabel('detached-tab', 'Detached tab')
    usePanesStore.setState({ tabs: [tab], activeTabId: tab.id, isDetachedWindow: true })

    render(<TabSections />)
    fireEvent.contextMenu(tabHeader('Detached tab'))
    fireEvent.click(screen.getByText('Bring to Main Window'))

    expect(ipc.invoke).toHaveBeenCalledWith('tab:reattach-home', tab.id)
    expect(screen.queryByText('Move Tab to New Window')).toBeNull()
  })
})

describe('TabSections - Jira status badges', () => {
  it('renders a clickable status badge without changing the active folder', () => {
    const tab = tabWithLabel('jira-tab', 'DZ-1234')
    usePanesStore.setState({ tabs: [tab], activeTabId: tab.id })
    useJiraStore.setState({
      hydrated: true,
      settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true },
      projects: { [tab.id]: { tabId: tab.id, label: 'DZ-1234', issueKey: 'DZ-1234', prefix: 'DZ-' } },
      rows: {
        [tab.id]: {
          tabId: tab.id,
          issueKey: 'DZ-1234',
          issueUrl: `${TEST_BASE_URL}/browse/DZ-1234`,
          statusName: 'Closed',
          phase: 'success',
          generation: 1,
          configVersion: 0,
          linkable: true,
        },
      },
    })
    const ipc = installMockIpc()

    render(<TabSections />)

    const badge = screen.getByRole('link', { name: /DZ-1234: Closed/ })
    expect(badge).toHaveAttribute('href', `${TEST_BASE_URL}/browse/DZ-1234`)
    fireEvent.click(badge)
    expect(ipc.invoke).toHaveBeenCalledWith('jira:open-issue', 'DZ-1234')
    expect(usePanesStore.getState().activeTabId).toBe(tab.id)
  })

  it('offers refresh in the matching project context menu', () => {
    const tab = tabWithLabel('jira-tab', 'DZ-1234')
    usePanesStore.setState({ tabs: [tab], activeTabId: tab.id })
    useJiraStore.setState({
      hydrated: true,
      settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true },
      projects: { [tab.id]: { tabId: tab.id, label: 'DZ-1234', issueKey: 'DZ-1234', prefix: 'DZ-' } },
      rows: {
        [tab.id]: {
          tabId: tab.id,
          issueKey: 'DZ-1234',
          statusName: 'In Progress',
          phase: 'success',
          generation: 1,
          configVersion: 0,
          linkable: false,
        },
      },
    })
    const ipc = installMockIpc()
    render(<TabSections />)
    fireEvent.contextMenu(tabHeader('DZ-1234'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Jira status' }))
    expect(ipc.invoke).toHaveBeenCalledWith('jira:fetch-status', 'DZ-1234')
  })
})
