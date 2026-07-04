import { useCallback, useMemo } from 'react'
import { useSessionsStore } from '../store/sessions'
import { usePanesStore } from '../store/panes'
import type { AgentKind, Session, PaneNode } from '../../../shared/types'

function sessionKey(agentKind: AgentKind, sessionId: string): string {
  return `${agentKind}:${sessionId}`
}

function collectSessionIds(node: PaneNode, ids: Set<string>): void {
  if (node.type === 'leaf') {
    if (node.agentKind && node.sessionId) ids.add(sessionKey(node.agentKind, node.sessionId))
    return
  }
  collectSessionIds(node.first, ids)
  collectSessionIds(node.second, ids)
}

export function useSessions() {
  const sessions = useSessionsStore((s) => s.sessions)
  const loading = useSessionsStore((s) => s.loading)
  const tabs = usePanesStore((s) => s.tabs)

  // Derive which sessions are currently open in panes. No filesystem watching
  // needed — the panes store is the source of truth for what's running.
  const liveIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tab of tabs) if (tab.rootNode) collectSessionIds(tab.rootNode, ids)
    return ids
  }, [tabs])

  // Override status for sessions that are open in a pane right now.
  const withLive = useMemo(
    () =>
      sessions.map((s) =>
        liveIds.has(sessionKey(s.agentKind, s.sessionId)) ? { ...s, status: 'live-attached' as const } : s
      ),
    [sessions, liveIds]
  )

  const resumable = useMemo(
    () => withLive.filter((s) => s.status === 'resumable' && !liveIds.has(sessionKey(s.agentKind, s.sessionId))),
    [withLive, liveIds],
  )
  const search = useCallback((query: string): Session[] => {
    const q = query.toLowerCase()
    return withLive.filter(
      (s) =>
        s.projectName.toLowerCase().includes(q) ||
        s.agentKind.toLowerCase().includes(q) ||
        s.displayName?.toLowerCase().includes(q) ||
        s.firstMessage?.toLowerCase().includes(q) ||
        s.lastMessage?.toLowerCase().includes(q)
    )
  }, [withLive])

  return {
    sessions: withLive,
    loading,
    resumable,
    search,
  }
}
