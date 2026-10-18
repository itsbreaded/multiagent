import { create } from 'zustand'
import type { DatabaseStatus } from '../../../shared/types'

interface DatabaseStatusStore {
  status: DatabaseStatus | null
  setStatus: (status: DatabaseStatus) => void
}

export const useDatabaseStatusStore = create<DatabaseStatusStore>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}))

if (typeof window !== 'undefined' && window.ipc) {
  window.ipc.on('database:status-changed', (status: unknown) => {
    useDatabaseStatusStore.getState().setStatus(status as DatabaseStatus)
  })
}
