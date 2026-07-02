import * as path from 'path'
import { execFile } from 'child_process'
import { watch, type FSWatcher } from 'chokidar'

type BranchUpdate = (cwdKeys: string[], branch: string | null) => void

interface RepositoryWatch {
  gitDir: string
  cwd: string
  branch: string | null
  cwdKeys: Set<string>
  watcher: FSWatcher
  refreshTimer: NodeJS.Timeout | null
  refreshVersion: number
}

export class GitBranchWatcher {
  private readonly repositories = new Map<string, RepositoryWatch>()
  private readonly cwdToRepository = new Map<string, string>()
  private readonly cwdReferences = new Map<string, number>()
  private readonly pendingCwds = new Map<string, Promise<string | null>>()

  constructor(private readonly onUpdate: BranchUpdate) {}

  async watchCwd(cwd: string): Promise<string | null> {
    if (!cwd.trim()) return null
    const cwdKey = normalizeCwdKey(cwd)
    this.cwdReferences.set(cwdKey, (this.cwdReferences.get(cwdKey) ?? 0) + 1)
    const knownRepository = this.cwdToRepository.get(cwdKey)
    if (knownRepository) return this.repositories.get(knownRepository)?.branch ?? null

    const pending = this.pendingCwds.get(cwdKey)
    if (pending) return pending

    const request = this.attachCwd(cwd, cwdKey).finally(() => this.pendingCwds.delete(cwdKey))
    this.pendingCwds.set(cwdKey, request)
    return request
  }

  unwatchCwd(cwd: string): void {
    if (!cwd.trim()) return
    const cwdKey = normalizeCwdKey(cwd)
    const references = (this.cwdReferences.get(cwdKey) ?? 0) - 1
    if (references > 0) {
      this.cwdReferences.set(cwdKey, references)
      return
    }
    this.cwdReferences.delete(cwdKey)
    const repositoryKey = this.cwdToRepository.get(cwdKey)
    this.cwdToRepository.delete(cwdKey)
    if (!repositoryKey) return
    const repository = this.repositories.get(repositoryKey)
    if (!repository) return
    repository.cwdKeys.delete(cwdKey)
    if (repository.cwdKeys.size > 0) return
    if (repository.refreshTimer) clearTimeout(repository.refreshTimer)
    void repository.watcher.close()
    this.repositories.delete(repositoryKey)
  }

  async retryUnresolvedCwd(cwd: string): Promise<void> {
    if (!cwd.trim()) return
    const cwdKey = normalizeCwdKey(cwd)
    if (!this.cwdReferences.has(cwdKey) || this.cwdToRepository.has(cwdKey)) return
    const pending = this.pendingCwds.get(cwdKey)
    const request = pending ?? this.attachCwd(cwd, cwdKey).finally(() => this.pendingCwds.delete(cwdKey))
    if (!pending) this.pendingCwds.set(cwdKey, request)
    const branch = await request
    if (this.cwdToRepository.has(cwdKey)) this.onUpdate([cwdKey], branch)
  }

  async dispose(): Promise<void> {
    const closes: Promise<void>[] = []
    for (const repository of this.repositories.values()) {
      if (repository.refreshTimer) clearTimeout(repository.refreshTimer)
      closes.push(repository.watcher.close())
    }
    this.repositories.clear()
    this.cwdToRepository.clear()
    this.cwdReferences.clear()
    this.pendingCwds.clear()
    await Promise.all(closes)
  }

  private async attachCwd(cwd: string, cwdKey: string): Promise<string | null> {
    let gitDir: string
    try {
      gitDir = await execGit(['rev-parse', '--absolute-git-dir'], cwd)
    } catch {
      return null
    }
    if (!gitDir) return null

    const repositoryKey = normalizePath(gitDir)
    let repository = this.repositories.get(repositoryKey)
    if (!repository) {
      const branch = await readBranch(cwd)
      repository = this.repositories.get(repositoryKey)
      if (!repository) {
        const watcher = watch(path.join(gitDir, 'HEAD'), {
          ignoreInitial: true,
          persistent: true,
          // Git commonly updates HEAD through lock + atomic rename.
          atomic: true,
        })
        repository = {
          gitDir,
          cwd,
          branch,
          cwdKeys: new Set(),
          watcher,
          refreshTimer: null,
          refreshVersion: 0,
        }
        this.repositories.set(repositoryKey, repository)
        const schedule = (): void => this.scheduleRefresh(repositoryKey)
        watcher.on('add', schedule).on('change', schedule).on('unlink', schedule).on('ready', schedule)
        watcher.on('error', (error) => console.warn(`[GitBranchWatcher] ${gitDir}:`, error))
      }
    }

    // React effects may be cleaned up while repository discovery is in flight.
    if (!this.cwdReferences.has(cwdKey)) {
      if (repository.cwdKeys.size === 0 && this.repositories.get(repositoryKey) === repository) {
        if (repository.refreshTimer) clearTimeout(repository.refreshTimer)
        this.repositories.delete(repositoryKey)
        void repository.watcher.close()
      }
      return repository.branch
    }
    repository.cwdKeys.add(cwdKey)
    this.cwdToRepository.set(cwdKey, repositoryKey)
    return repository.branch
  }

  private scheduleRefresh(repositoryKey: string): void {
    const repository = this.repositories.get(repositoryKey)
    if (!repository) return
    if (repository.refreshTimer) clearTimeout(repository.refreshTimer)
    repository.refreshTimer = setTimeout(() => {
      repository.refreshTimer = null
      void this.refresh(repositoryKey)
    }, 40)
  }

  private async refresh(repositoryKey: string): Promise<void> {
    const repository = this.repositories.get(repositoryKey)
    if (!repository) return
    const version = ++repository.refreshVersion
    const branch = await readBranch(repository.cwd)
    if (version !== repository.refreshVersion || this.repositories.get(repositoryKey) !== repository) return
    if (branch === repository.branch) return
    repository.branch = branch
    this.onUpdate([...repository.cwdKeys], branch)
  }
}

async function readBranch(cwd: string): Promise<string | null> {
  try {
    const branch = await execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
    if (branch) return branch
  } catch {
    // Detached HEAD is expected to make symbolic-ref exit non-zero.
  }
  try {
    const head = await execGit(['rev-parse', '--short', 'HEAD'], cwd)
    return head ? `detached@${head}` : null
  } catch {
    return null
  }
}

function execGit(args: string[], cwd: string, timeout = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.toString().trim())
    })
  })
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeCwdKey(cwd: string): string {
  return cwd.replace(/\//g, '\\').toLowerCase()
}
