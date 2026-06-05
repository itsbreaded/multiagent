import { create } from 'zustand'
import type { Session } from '../../../shared/types'

interface SessionsStore {
  sessions: Session[]
  loading: boolean
  setSessions: (sessions: Session[]) => void
  searchSessions: (query: string) => Promise<Session[]>
  deleteSession: (sessionId: string) => Promise<void>
  getByProject: (cwd: string) => Session[]
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: [],
  loading: true,

  setSessions: (sessions) => set({ sessions, loading: false }),

  searchSessions: async (query) => {
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        return (await window.ipc.invoke('sessions:search', query)) as Session[]
      } catch {
        // fall through to local filter
      }
    }
    const q = query.toLowerCase()
    return get().sessions.filter(
      (s) =>
        s.projectName.toLowerCase().includes(q) ||
        s.firstMessage?.toLowerCase().includes(q) ||
        s.lastMessage?.toLowerCase().includes(q)
    )
  },

  deleteSession: async (sessionId) => {
    if (typeof window !== 'undefined' && window.ipc) {
      await window.ipc.invoke('sessions:delete', sessionId)
    }
    set((s) => ({ sessions: s.sessions.filter((sess) => sess.sessionId !== sessionId) }))
  },

  getByProject: (cwd) => get().sessions.filter((s) => s.cwd === cwd),
}))

// Subscribe to IPC updates after store is created
if (typeof window !== 'undefined' && window.ipc) {
  window.ipc.on('sessions:updated', (sessions: unknown) => {
    useSessionsStore.getState().setSessions(sessions as Session[])
  })
}
