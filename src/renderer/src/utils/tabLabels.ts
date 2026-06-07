import type { Tab, PaneNode, PaneLeaf, Session } from '../../../shared/types'

export function findLeafById(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeafById(node.first, id) ?? findLeafById(node.second, id)
}

export function firstLeaf(node: PaneNode): PaneLeaf | null {
  if (node.type === 'leaf') return node
  return firstLeaf(node.first)
}

export function collectLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return [...collectLeaves(node.first), ...collectLeaves(node.second)]
}

/** Formatted display label for a single pane: "[customName · ]directory" */
export function paneLabelText(pane: PaneLeaf, sessions: Session[]): string {
  let base: string
  if (pane.paneType === 'claude' && pane.sessionId) {
    const session = sessions.find((s) => s.sessionId === pane.sessionId)
    if (session) {
      base = session.projectName.split('/').pop() ?? session.projectName
    } else {
      base = pane.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Claude'
    }
  } else {
    base = pane.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Shell'
  }
  return pane.customName ? `${pane.customName} · ${base}` : base
}

function baseLabel(tab: Tab, sessions: Session[]): string {
  if (!tab.rootNode) return 'New Tab'
  const leaf = findLeafById(tab.rootNode, tab.focusedPaneId) ?? firstLeaf(tab.rootNode)
  if (!leaf) return 'Shell'
  if (leaf.sessionId) {
    const session = sessions.find((s) => s.sessionId === leaf.sessionId)
    if (session) return session.projectName.split('/').pop() ?? session.projectName
  }
  const segment = leaf.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop()
  return segment || 'Shell'
}

export function computeLabels(tabs: Tab[], sessions: Session[]): Map<string, string> {
  const labels = new Map<string, string>()
  let shellCount = 0
  for (const tab of tabs) {
    if (tab.customLabel) {
      labels.set(tab.id, tab.customLabel)
      continue
    }
    const base = baseLabel(tab, sessions)
    if (base === 'Shell') {
      shellCount++
      labels.set(tab.id, shellCount === 1 ? 'Shell' : `Shell ${shellCount}`)
    } else {
      labels.set(tab.id, base)
    }
  }
  return labels
}
