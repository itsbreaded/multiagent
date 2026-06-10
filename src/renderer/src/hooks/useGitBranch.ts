import { useEffect } from 'react'
import { normalizeCwdKey, usePanesStore } from '../store/panes'

export function useGitBranch(cwd: string | undefined, enabled = true, isFocused = false): string | null {
  const requestGitBranch = usePanesStore((s) => s.requestGitBranch)
  const refreshGitBranch = usePanesStore((s) => s.refreshGitBranch)
  const branchEntry = usePanesStore((s) => cwd ? s.cwdGitBranches[normalizeCwdKey(cwd)] : undefined)

  useEffect(() => {
    if (enabled && cwd) requestGitBranch(cwd)
  }, [cwd, enabled, requestGitBranch])

  // When a pane gains focus, bypass the cache and fetch the current branch
  useEffect(() => {
    if (enabled && cwd && isFocused) refreshGitBranch(cwd)
  }, [isFocused, cwd, enabled, refreshGitBranch])

  return branchEntry?.branch ?? null
}
