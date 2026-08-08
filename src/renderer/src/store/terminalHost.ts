import { create } from 'zustand'
import type { TerminalHostStatus } from '../../../shared/types'

interface TerminalHostState {
  status: Exclude<TerminalHostStatus, { state: 'recovered' }> | null
  setStatus: (status: TerminalHostStatus) => void
  restart: () => Promise<void>
}

export const useTerminalHostStore = create<TerminalHostState>((set) => ({
  status: null,
  setStatus: (status) => set({ status: status.state === 'recovered' ? null : status }),
  restart: async () => {
    if (typeof window === 'undefined' || !window.ipc) return
    await window.ipc.invoke('app:restart')
  },
}))

export function isTerminalHostStatus(value: unknown): value is TerminalHostStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Record<string, unknown>
  if (typeof status.incidentId !== 'string') return false
  if (status.state === 'recovered') return true
  if (status.state !== 'recovering' && status.state !== 'failed') return false
  return (typeof status.code === 'number' || status.code === null) &&
    Array.isArray(status.affectedPtyIds) &&
    Array.isArray(status.unreadyPtyIds) &&
    Array.isArray(status.unreadyNewAgentPtyIds)
}

// Wire this once at module load, matching the updater store. Pane transitions
// are handled by panesIpc; this store owns only the global banner state.
if (typeof window !== 'undefined' && window.ipc) {
  window.ipc.on('terminal-host:status', (status: unknown) => {
    if (isTerminalHostStatus(status)) useTerminalHostStore.getState().setStatus(status)
  })
  void window.ipc.invoke('terminal-host:get-status').then((status) => {
    if (isTerminalHostStatus(status)) useTerminalHostStore.getState().setStatus(status)
  }).catch(() => {})
}
