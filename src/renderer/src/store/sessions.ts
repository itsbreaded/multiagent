import { create } from 'zustand'
import type { AgentKind, Session, SessionRepairCwdResult } from '../../../shared/types'

interface SessionsStore {
  sessions: Session[]
  loading: boolean
  setSessions: (sessions: Session[]) => void
  searchSessions: (query: string) => Promise<Session[]>
  deleteSession: (agentKind: AgentKind, sessionId: string) => Promise<void>
  repairSessionCwd: (oldCwd: string, newCwd: string) => Promise<SessionRepairCwdResult>
  getByProject: (cwd: string) => Session[]
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: [],
  loading: true,

  setSessions: (sessions) => set({ sessions, loading: false }),

  searchSessions: async (query) => {
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        return await window.ipc.invoke('sessions:search', query)
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

  deleteSession: async (agentKind, sessionId) => {
    if (typeof window !== 'undefined' && window.ipc) {
      await window.ipc.invoke('sessions:delete', agentKind, sessionId)
    }
    set((s) => ({ sessions: s.sessions.filter((sess) => !(sess.agentKind === agentKind && sess.sessionId === sessionId)) }))
  },

  repairSessionCwd: async (oldCwd, newCwd) => {
    let result: SessionRepairCwdResult = { ok: false, sessions: [], error: 'Repair is unavailable' }
    if (typeof window !== 'undefined' && window.ipc) {
      result = await window.ipc.invoke('sessions:repair-cwd', oldCwd, newCwd)
    }
    const updated = result.sessions
    if (updated.length > 0) {
      const keys = new Set(updated.map((session) => `${session.agentKind}:${session.sessionId}`))
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          keys.has(`${sess.agentKind}:${sess.sessionId}`)
            ? updated.find((candidate) => candidate.agentKind === sess.agentKind && candidate.sessionId === sess.sessionId) ?? sess
            : sess
        ),
      }))
    }
    return result
  },

  getByProject: (cwd) => get().sessions.filter((s) => s.cwd === cwd),
}))

// Subscribe to IPC updates after store is created
if (typeof window !== 'undefined' && window.ipc) {
  window.ipc.on('sessions:updated', (sessions: unknown) => {
    useSessionsStore.getState().setSessions(sessions as Session[])
  })
}
