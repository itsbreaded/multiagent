import { create } from 'zustand'
import type { UpdaterStatus } from '../../../shared/types'

interface UpdaterState {
  status: UpdaterStatus | null
  dismissed: boolean
  setStatus: (s: UpdaterStatus) => void
  dismiss: () => void
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
  status: null,
  dismissed: false,
  setStatus: (s) => set((prev) => ({
    status: s,
    dismissed: s.state === 'available' ? false : prev.dismissed,
  })),
  dismiss: () => set({ dismissed: true }),
}))

// Wire IPC at module level — fires once, no component re-registration
const UPDATER_STATES = new Set(['available', 'preparing', 'downloading', 'ready', 'up-to-date', 'error'])
if (typeof window !== 'undefined' && window.ipc) {
  window.ipc.on('updater:status', (s: unknown) => {
    if (!s || typeof s !== 'object') return
    const state = (s as { state?: unknown }).state
    if (typeof state !== 'string' || !UPDATER_STATES.has(state)) return
    useUpdaterStore.getState().setStatus(s as UpdaterStatus)
  })
}
