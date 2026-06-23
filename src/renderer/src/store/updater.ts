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
window.ipc.on('updater:status', (s: unknown) => {
  const status = s as UpdaterStatus
  const store = useUpdaterStore.getState()
  store.setStatus(status)
})
