import { useSessionsStore } from '../store/sessions'
import type { Session } from '../../../shared/types'

export function useSessions() {
  const store = useSessionsStore()
  return {
    sessions: store.sessions,
    loading: store.loading,
    live: store.liveSessions(),
    resumable: store.resumableSessions(),
    archived: store.archivedSessions(),
    // Synchronous local search used by CommandPalette / SessionBrowser.
    // IPC-backed async search is available via store.searchSessions directly.
    search: (query: string): Session[] => {
      const q = query.toLowerCase()
      return store.sessions.filter(
        (s) =>
          s.projectName.toLowerCase().includes(q) ||
          s.firstMessage?.toLowerCase().includes(q) ||
          s.lastMessage?.toLowerCase().includes(q)
      )
    },
  }
}
