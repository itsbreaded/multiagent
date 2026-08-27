import type { PaneLeaf, Tab } from '../../../shared/types'

export const IDLE_SUSPENSION_EVALUATION_INTERVAL_MS = 1_000

export function hasExactSessionIdentity(pane: PaneLeaf): boolean {
  return (
    pane.paneType === 'agent' &&
    (pane.agentKind === 'claude' || pane.agentKind === 'codex' || pane.agentKind === 'opencode') &&
    typeof pane.sessionId === 'string' && pane.sessionId.trim().length > 0 &&
    typeof pane.cwd === 'string' && pane.cwd.trim().length > 0
  )
}

export function isIdleAgentSuspensionEligible(pane: PaneLeaf): boolean {
  return (
    hasExactSessionIdentity(pane) &&
    typeof pane.ptyId === 'string' && pane.ptyId.length > 0 &&
    pane.agentStatus?.status === 'idle' &&
    pane.agentStatus?.suspensionBlocked !== true &&
    pane.agentSuspension === undefined
  )
}

export function isTabFocused(
  tab: Tab,
  activeTabId: string,
  windowId: number | null,
  activeWindowId: number | null,
): boolean | null {
  if (windowId === null || activeWindowId === null) return null
  return tab.id === activeTabId && activeWindowId === windowId
}

export function collectPolicySuspendedPanes(tab: Tab): PaneLeaf[] {
  if (!tab.rootNode) return []
  const panes: PaneLeaf[] = []
  const visit = (node: Tab['rootNode']): void => {
    if (!node) return
    if (node.type === 'leaf') {
      if (node.paneType === 'agent' && node.agentSuspension?.reason === 'idle-policy') panes.push(node)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(tab.rootNode)
  return panes
}
