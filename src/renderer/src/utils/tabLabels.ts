import type { Tab, PaneNode, PaneLeaf, Session } from '../../../shared/types'
import { agentLabel } from './agents'

export function findLeafById(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeafById(node.first, id) ?? findLeafById(node.second, id)
}

export function firstLeaf(node: PaneNode): PaneLeaf | null {
  if (node.type === 'leaf') return node
  return firstLeaf(node.first)
}

/** Formatted display label for a single pane: "[customName · ]directory" */
export function paneLabelText(pane: PaneLeaf, sessions: Session[]): string {
  let base: string
  if (pane.paneType === 'agent') {
    const session = pane.agentKind && pane.sessionId
      ? sessions.find((s) => s.agentKind === pane.agentKind && s.sessionId === pane.sessionId)
      : null
    if (session) {
      base = session.projectName.split('/').pop() ?? session.projectName
    } else {
      base = pane.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || agentLabel(pane.agentKind ?? 'claude')
    }
  } else {
    base = pane.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Shell'
  }
  return pane.customName ? `${pane.customName} · ${base}` : base
}

function baseLabel(tab: Tab, sessions: Session[]): string {
  if (!tab.rootNode) return 'Tab'
  const leaf = findLeafById(tab.rootNode, tab.focusedPaneId) ?? firstLeaf(tab.rootNode)
  if (!leaf) return 'Shell'
  if (leaf.sessionId) {
    const session = leaf.agentKind
      ? sessions.find((s) => s.agentKind === leaf.agentKind && s.sessionId === leaf.sessionId)
      : null
    if (session) return session.projectName.split('/').pop() ?? session.projectName
  }
  const segment = leaf.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop()
  return segment || 'Shell'
}

export function computeLabels(tabs: Tab[], sessions: Session[]): Map<string, string> {
  const labels = new Map<string, string>()
  const usedLabels = new Set(
    tabs
      .map((tab) => tab.customLabel?.trim().toLowerCase())
      .filter((label): label is string => !!label)
  )
  let shellCount = 0
  let tabCount = 0
  for (const tab of tabs) {
    if (tab.customLabel) {
      labels.set(tab.id, tab.customLabel)
      continue
    }
    const base = baseLabel(tab, sessions)
    if (base === 'Shell') {
      shellCount++
      labels.set(tab.id, shellCount === 1 ? 'Shell' : `Shell ${shellCount}`)
    } else if (base === 'Tab') {
      tabCount++
      let n = tabCount
      while (usedLabels.has(`tab ${n}`)) n++
      const label = `Tab ${n}`
      usedLabels.add(label.toLowerCase())
      labels.set(tab.id, label)
    } else {
      labels.set(tab.id, base)
    }
  }
  return labels
}
