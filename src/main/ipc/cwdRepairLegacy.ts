import { posix, win32 } from 'path'
import type { CwdRepairMapping } from '../../shared/types'

/**
 * Historical main-process cwd rewrite, retained only as a golden master for
 * the behavior that preceded the shared, platform-agnostic implementation.
 *
 * `platform` selects the path API explicitly so both former host-dependent
 * branches remain deterministic on every developer machine and in CI.
 */
export function legacyReplaceCwdPrefix(
  value: string,
  mapping: CwdRepairMapping,
  platform: 'win32' | 'posix'
): string {
  const hostPath = platform === 'win32' ? win32 : posix
  const oldRoot = hostPath.resolve(mapping.oldCwd)
  const newRoot = hostPath.resolve(mapping.newCwd)
  const candidate = hostPath.resolve(value)
  const comparable = (pathValue: string): string => {
    const normalized = hostPath.normalize(pathValue)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  const oldKey = comparable(oldRoot)
  const candidateKey = comparable(candidate)
  if (candidateKey === oldKey) return newRoot

  const sep = hostPath.sep
  if (!candidateKey.startsWith(oldKey.endsWith(sep) ? oldKey : `${oldKey}${sep}`)) return value
  let suffix = candidate.slice(oldRoot.length)
  while (suffix.startsWith(hostPath.sep) || suffix.startsWith('/') || suffix.startsWith('\\')) {
    suffix = suffix.slice(1)
  }
  return hostPath.join(newRoot, suffix)
}
