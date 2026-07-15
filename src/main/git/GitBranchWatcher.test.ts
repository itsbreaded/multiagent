import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitBranchWatcher } from './GitBranchWatcher'

const tempPaths: string[] = []
const watchers: GitBranchWatcher[] = []

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.dispose()))
  for (const tempPath of tempPaths.splice(0).reverse()) {
    // dispose() awaits chokidar's watcher.close(), but on Windows that promise can resolve
    // before the OS actually releases the directory handle, so an immediate rmSync can hit
    // EPERM. Retry budget widened (5x50ms -> 10x200ms) to absorb that without masking a real
    // leak (a handle still held after 2s would keep failing regardless of budget).
    rmSync(tempPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

describe('GitBranchWatcher', () => {
  it('starts watching when a repository is initialized after the first lookup', async () => {
    const directory = tempDirectory()
    const updates: Array<string | null> = []
    const watcher = track(new GitBranchWatcher((_cwdKeys, branch) => updates.push(branch)))
    expect(await watcher.watchCwd(directory)).toBeNull()

    git(directory, 'init')
    await watcher.retryUnresolvedCwd(directory)
    const initialBranch = currentBranch(directory)
    expect(updates).toContain(initialBranch)

    git(directory, 'switch', '-c', 'initialized-later')
    await waitFor(() => updates.at(-1) === 'initialized-later')
  })

  it('pushes branch changes after Git atomically replaces HEAD', async () => {
    const repo = createRepository()
    const updates: Array<{ cwdKeys: string[]; branch: string | null }> = []
    const watcher = track(new GitBranchWatcher((cwdKeys, branch) => updates.push({ cwdKeys, branch })))

    expect(await watcher.watchCwd(repo)).toBe(currentBranch(repo))
    git(repo, 'switch', '-c', 'feature/watched')

    await waitFor(() => updates.some((update) => update.branch === 'feature/watched'))
    expect(updates.at(-1)?.cwdKeys).toContain(normalizeCwdKey(repo))
  })

  it('reports detached HEADs and returns to the branch name', async () => {
    const repo = createRepository()
    const branch = currentBranch(repo)
    const updates: Array<string | null> = []
    const watcher = track(new GitBranchWatcher((_cwdKeys, value) => updates.push(value)))
    await watcher.watchCwd(repo)

    git(repo, 'switch', '--detach')
    await waitFor(() => updates.some((value) => value?.startsWith('detached@') === true))

    git(repo, 'switch', branch)
    await waitFor(() => updates.at(-1) === branch)
  })

  it('resolves linked worktree git directories and shares one watch across subdirectories', { timeout: 15_000 }, async () => {
    const repo = createRepository()
    const root = tempDirectory()
    const worktree = join(root, 'worktree')
    git(repo, 'worktree', 'add', '-b', 'worktree-start', worktree)
    const nested = join(worktree, 'nested')
    mkdirSync(nested)
    const updates: Array<{ cwdKeys: string[]; branch: string | null }> = []
    const watcher = track(new GitBranchWatcher((cwdKeys, branch) => updates.push({ cwdKeys, branch })))

    expect(await watcher.watchCwd(worktree)).toBe('worktree-start')
    expect(await watcher.watchCwd(nested)).toBe('worktree-start')
    git(worktree, 'switch', '-c', 'worktree-next')

    await waitFor(() => updates.some((update) => update.branch === 'worktree-next'), 12_000)
    const update = updates.find((item) => item.branch === 'worktree-next')!
    expect(update.cwdKeys).toEqual(expect.arrayContaining([
      normalizeCwdKey(worktree),
      normalizeCwdKey(nested),
    ]))
    git(repo, 'worktree', 'remove', '--force', worktree)
  })
})

function createRepository(): string {
  const repo = tempDirectory()
  git(repo, 'init')
  writeFileSync(join(repo, 'tracked.txt'), 'initial')
  git(repo, 'add', 'tracked.txt')
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial')
  return repo
}

function tempDirectory(): string {
  const value = mkdtempSync(join(tmpdir(), 'multiagent-git-watch-'))
  tempPaths.push(value)
  return value
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function currentBranch(cwd: string): string {
  return git(cwd, 'branch', '--show-current')
}

function track(watcher: GitBranchWatcher): GitBranchWatcher {
  watchers.push(watcher)
  return watcher
}

function normalizeCwdKey(cwd: string): string {
  return cwd.replace(/\//g, '\\').toLowerCase()
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Git branch update')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
