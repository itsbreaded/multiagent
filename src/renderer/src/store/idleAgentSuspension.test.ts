import { describe, expect, it, vi } from 'vitest'
import { makeLeaf } from '../../../shared/paneTree'
import type { Tab } from '../../../shared/types'
import { installMockIpc } from '../../../../tests/mockIpc'
import { useSettingsStore } from './settings'
import {
  collectPolicySuspendedPanes,
  hasExactSessionIdentity,
  isIdleAgentSuspensionEligible,
  isTabFocused,
} from './idleAgentSuspension'
import { startIdleAgentSuspensionCoordinator, usePanesStore } from './panes'

function agent(): ReturnType<typeof makeLeaf> {
  const pane = makeLeaf('C:\\work', 'agent', 'codex')
  pane.sessionId = 'session-1'
  pane.ptyId = 'pty-1'
  pane.agentStatus = { status: 'idle', updatedAt: 1 }
  return pane
}

describe('idle suspension eligibility', () => {
  it.each(['claude', 'codex', 'opencode'] as const)('requires exact identity, a live pty, and explicit idle state for %s', (agentKind) => {
    const pane = agent()
    pane.agentKind = agentKind
    expect(hasExactSessionIdentity(pane)).toBe(true)
    expect(isIdleAgentSuspensionEligible(pane)).toBe(true)
    pane.agentStatus = { status: 'idle', suspensionBlocked: true, updatedAt: 2 }
    expect(isIdleAgentSuspensionEligible(pane)).toBe(false)
    pane.agentStatus = { status: 'working', updatedAt: 2 }
    expect(isIdleAgentSuspensionEligible(pane)).toBe(false)
    pane.agentStatus = {
      status: 'working',
      activeBackgroundSubagents: 1,
      activeBackgroundSubagentIds: ['sub-1'],
      updatedAt: 2,
    }
    expect(isIdleAgentSuspensionEligible(pane)).toBe(false)
    pane.agentStatus = { status: 'unknown', updatedAt: 2 }
    expect(isIdleAgentSuspensionEligible(pane)).toBe(false)
    pane.agentStatus = { status: 'idle', updatedAt: 3 }
    pane.sessionId = undefined
    expect(hasExactSessionIdentity(pane)).toBe(false)
    expect(isIdleAgentSuspensionEligible(pane)).toBe(false)
  })

  it('treats unknown OS focus as a baseline rather than inactive', () => {
    const tab: Tab = { id: 't1', rootNode: agent(), focusedPaneId: '' }
    expect(isTabFocused(tab, 't1', 1, null)).toBeNull()
    expect(isTabFocused(tab, 't1', 1, 2)).toBe(false)
    expect(isTabFocused(tab, 't1', 1, 1)).toBe(true)
  })

  it('collects all policy-suspended panes in a returned tab', () => {
    const first = agent()
    first.agentSuspension = { reason: 'idle-policy', at: 10 }
    const second = agent()
    second.id = 'pane-2'
    second.agentSuspension = { reason: 'idle-policy', at: 10 }
    const tab: Tab = { id: 't1', rootNode: { ...first }, focusedPaneId: first.id }
    expect(collectPolicySuspendedPanes(tab)).toHaveLength(1)
    expect(collectPolicySuspendedPanes({ ...tab, rootNode: { type: 'split', id: 's', direction: 'vertical', ratio: 0.5, first, second } })).toHaveLength(2)
  })

  it('suspends an eligible pane after its owning tab is independently unfocused', async () => {
    vi.useFakeTimers()
    const pane = agent()
    const tab: Tab = { id: 't1', rootNode: pane, focusedPaneId: pane.id }
    installMockIpc()
    useSettingsStore.setState({ idleAgentSuspension: { enabled: true, timeoutMinutes: 1 } })
    usePanesStore.setState({
      tabs: [tab],
      activeTabId: 'other-tab',
      windowId: 1,
      activeWindowId: 2,
      isDetachedWindow: false,
    })
    const stop = startIdleAgentSuspensionCoordinator()
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentSuspension?.reason).toBe('idle-policy')
    stop()
    vi.useRealTimers()
  })

  it('automatically resumes a policy-suspended active pane once and resets it idle while pending', async () => {
    vi.useFakeTimers()
    const pane = agent()
    pane.ptyId = undefined
    pane.agentStatus = { status: 'working', updatedAt: 1 }
    pane.agentSuspension = { reason: 'idle-policy', at: 1 }
    const tab: Tab = { id: 't1', rootNode: pane, focusedPaneId: pane.id }
    const ipc = installMockIpc()
    let resolveResume!: (value: { ptyId: string }) => void
    ipc.invoke.mockImplementation((channel: string) => channel === 'session:resume'
      ? new Promise<{ ptyId: string }>((resolve) => { resolveResume = resolve })
      : Promise.resolve(undefined))
    useSettingsStore.setState({ idleAgentSuspension: { enabled: true, timeoutMinutes: 1 } })
    usePanesStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      windowId: 1,
      activeWindowId: 1,
      isDetachedWindow: false,
    })

    const stop = startIdleAgentSuspensionCoordinator()
    expect(ipc.invoke.mock.calls.filter((call: unknown[]) => call[0] === 'session:resume')).toHaveLength(1)
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('idle')

    resolveResume({ ptyId: 'pty-resumed' })
    await Promise.resolve()
    await Promise.resolve()
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.ptyId).toBe('pty-resumed')
    stop()
    vi.useRealTimers()
  })
})
