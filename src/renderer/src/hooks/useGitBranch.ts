import { useEffect } from 'react'
import { normalizeCwdKey, usePanesStore } from '../store/panes'

export function useGitBranch(cwd: string | undefined, enabled = true): string | null | undefined {
  const requestGitBranch = usePanesStore((s) => s.requestGitBranch)
  const branchEntry = usePanesStore((s) => cwd ? s.cwdGitBranches[normalizeCwdKey(cwd)] : undefined)

  useEffect(() => {
    if (!enabled || !cwd) return
    requestGitBranch(cwd)
    return () => { void window.ipc?.invoke('git:unwatch-branch', cwd).catch(() => {}) }
  }, [cwd, enabled, requestGitBranch])

  return branchEntry?.status === 'ready' ? branchEntry.branch : undefined
}
