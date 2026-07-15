/**
 * agentProcessDetect — pure identification of a CLI agent from the process tree.
 *
 * Reimplements (not vendored) the foreground-agent identification technique from the
 * read-only `herdr` reference repo (AGPL-3.0). herdr is consulted for technique only;
 * no source or rule text is copied. See spec 047.
 *
 * Two pure layers:
 *   1. `identifyAgentFromProcess(name, argv)` — map a single process's name + argv to an
 *      AgentKind, unwrapping generic runtime/shell wrappers (node, cmd, powershell, …).
 *   2. `selectForegroundAgent(shellPid, entries)` — walk a process snapshot's descendants
 *      of a shell pid and apply herdr's disambiguation to pick the single foreground agent.
 *
 * This module is pure so it can be unit-tested with synthetic snapshots (CLAUDE.md
 * testability discipline — like `buildEnv` / `paneTree`). No native or IO coupling here.
 */

import type { AgentKind } from '../../shared/types'

/** Structural process entry consumed by the pure selector. */
export interface ProcessEntry {
  pid: number
  parentPid: number
  name: string
  argv: string[]
}

// Programs that merely wrap a real agent command. When one of these is the foreground
// process, we parse its argv to find the wrapped agent token rather than trusting the
// wrapper name itself. Keep this lowercased for case-insensitive matching.
const RUNTIME_WRAPPERS = new Set([
  'node', 'bun', 'python', 'python3', 'py',
  'cmd', 'powershell', 'pwsh',
  'sh', 'bash', 'zsh', 'fish',
  'npx', // npx <pkg> — resolves to an agent package
])

// Agent program names (after suffix stripping). `claude-code` is the npm package bin name.
const CLAUDE_NAMES = new Set(['claude', 'claude-code'])
const CODEX_NAMES = new Set(['codex'])

// Package-path markers used by npm-installed agents. On this machine:
//   - claude is a standalone .exe at C:\Users\cdhan\.local\bin\claude.exe (direct name match)
//   - codex is an npm global: node …\node_modules\@openai\codex\bin\codex.js (wrapper path)
// We match the package scope loosely so a different install root still classifies.
const CODEX_PACKAGE_RE = /(?:^|[\\/])@openai[\\/]codex(?:[\\/]|\b)/i
const CLAUDE_PACKAGE_RE = /(?:^|[\\/])@anthropic-ai[\\/]claude-code(?:[\\/]|\b)/i
const CODEX_FILE_RE = /(?:^|[\\/])codex\.(?:js|mjs|cjs|cmd|bat|ps1)$/i
const CLAUDE_FILE_RE = /(?:^|[\\/])claude(?:-code)?\.(?:js|mjs|cjs|cmd|bat|ps1)$/i

/** Strip a Windows/Unix executable suffix so `claude.exe`/`codex.cmd` → `claude`/`codex`. */
function stripExecutableSuffix(name: string): string {
  return name.replace(/\.(?:exe|cmd|bat|ps1|js|mjs|cjs)$/i, '')
}

function classifyToken(token: string): AgentKind | null {
  if (!token) return null
  const stripped = stripExecutableSuffix(token).toLowerCase()
  // A bare agent name as an argv token (e.g. `cmd /c claude` → token "claude").
  if (CLAUDE_NAMES.has(stripped)) return 'claude'
  if (CODEX_NAMES.has(stripped)) return 'codex'
  // Package paths / file shims.
  if (CODEX_PACKAGE_RE.test(token) || CODEX_FILE_RE.test(token)) return 'codex'
  if (CLAUDE_PACKAGE_RE.test(token) || CLAUDE_FILE_RE.test(token)) return 'claude'
  return null
}

/**
 * Identify an agent from a single process's name + argv. Returns null for plain shells,
 * plain commands (git, vim, node build.js), and eval/script payloads that merely mention
 * an agent name. Conservative: when in doubt, return null.
 *
 * Eval/script payloads (`-e`, `--eval`, `-c <script>`, `-Command <script>`) are skipped:
 * the script body may contain the word "codex"/"claude" without being that agent.
 */
export function identifyAgentFromProcess(name: string, argv: string[]): AgentKind | null {
  const baseName = stripExecutableSuffix(name).toLowerCase()

  // Direct agent process (e.g. the standalone claude.exe on this machine).
  if (CLAUDE_NAMES.has(baseName)) return 'claude'
  if (CODEX_NAMES.has(baseName)) return 'codex'

  // Only unwrap known generic runtimes/shells. An unknown program named "build.js" that
  // happens to sit next to a codex dir must not classify as an agent.
  if (!RUNTIME_WRAPPERS.has(baseName)) return null

  // Walk the wrapper's argv and classify the first non-flag token that names an agent,
  // skipping eval/script payloads. argv[0] is the wrapper itself; start at 1.
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok) continue

    // node/bun eval payloads: skip the eval string and continue.
    if (tok === '-e' || tok === '--eval') { i++; continue }
    // Generic -- separator: everything after is the program + its args.
    if (tok === '--') {
      const next = argv[i + 1]
      const kind = next ? classifyToken(next) : null
      if (kind) return kind
      continue
    }
    // python -c <script> / sh -c <script>: skip the script body.
    if (tok === '-c') { i++; continue }

    // cmd.exe: /c or /k precedes the command. Classify the command token (and, if it is
    // a wrapper itself like `node`, recurse-style scan of the rest).
    if (baseName === 'cmd' && (/^\/[ck]$/i.test(tok))) {
      const cmdTok = argv[i + 1]
      const kind = cmdTok ? classifyToken(cmdTok) : null
      if (kind) return kind
      // `cmd /c node …codex.js` — keep scanning the remaining tokens below.
      i++
      continue
    }

    // powershell/pwsh: -File <path> / -Command <script>. -Command is a script body → skip.
    if (baseName === 'powershell' || baseName === 'pwsh') {
      if (/^-command$/i.test(tok)) { i++; continue }
      if (/^-file$/i.test(tok)) {
        const fileTok = argv[i + 1]
        const kind = fileTok ? classifyToken(fileTok) : null
        if (kind) return kind
        i++
        continue
      }
      // -ExecutionPolicy Bypass -NoProfile … then -Command <script> or the script path.
      // Fall through: the next non-flag token may be the script path.
    }

    // node/bun/npx/python running a script file: classify the token as a file path.
    if (baseName === 'node' || baseName === 'bun' || baseName === 'npx' || baseName === 'python' || baseName === 'py' || baseName === 'python3') {
      const kind = classifyToken(tok)
      if (kind) return kind
      continue
    }

    // cmd/shell otherwise: classify any token that names an agent.
    const kind = classifyToken(tok)
    if (kind) return kind
  }

  return null
}

/**
 * Split a Windows command line into argv, honoring double quotes. Good enough for
 * process-tree command lines — not a full shell lexer, but matches `@vscode/windows-
 * process-tree`'s `commandLine` shape (already-split by the addon where available, but
 * we keep this for callers that pass a raw string).
 */
export function splitCommandLine(cmdline: string): string[] {
  const out: string[] = []
  let buf = ''
  let inQuotes = false
  for (let i = 0; i < cmdline.length; i++) {
    const ch = cmdline[i]
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ' ' && !inQuotes) {
      if (buf) { out.push(buf); buf = '' }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

/**
 * Walk the descendant tree of `shellPid` and apply herdr's disambiguation:
 *   - collect every descendant process that `identifyAgentFromProcess` recognizes;
 *   - zero candidates → null (stay shell);
 *   - multiple distinct agent kinds → null (ambiguous);
 *   - candidates that do NOT form a single ancestor-descendant chain (sibling chains)
 *     → null (ambiguous, even if same agent);
 *   - otherwise → the single agent kind (the topmost ancestor of the chain).
 *
 * Cycle-safe via a visited set (a malformed snapshot with a pid cycle must not loop).
 */
export function selectForegroundAgent(shellPid: number | null, entries: ProcessEntry[]): AgentKind | null {
  if (shellPid == null || entries.length === 0) return null

  const byPid = new Map<number, ProcessEntry>()
  for (const e of entries) byPid.set(e.pid, e)

  // Collect descendants of shellPid (the shell itself is NOT a candidate).
  const candidates: ProcessEntry[] = []
  const visited = new Set<number>()
  const stack: number[] = [shellPid]
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (visited.has(pid)) continue
    visited.add(pid)
    const entry = byPid.get(pid)
    if (entry) {
      if (pid !== shellPid) {
        const kind = identifyAgentFromProcess(entry.name, entry.argv)
        if (kind) candidates.push(entry)
      }
    }
    // Push children (entries whose parentPid === this pid). A child map is cheaper, but
    // a linear scan is fine for the snapshot sizes we see per pane.
    for (const e of entries) {
      if (e.parentPid === pid && !visited.has(e.pid)) stack.push(e.pid)
    }
  }

  if (candidates.length === 0) return null

  // Multiple distinct agent kinds → ambiguous.
  const kinds = new Set<AgentKind>()
  for (const c of candidates) {
    kinds.add(identifyAgentFromProcess(c.name, c.argv)!)
  }
  if (kinds.size > 1) return null

  // "Top" candidates = those with no candidate ancestor. Exactly one → single chain.
  const candidatePids = new Set(candidates.map((c) => c.pid))
  const hasAncestorCandidate = (pid: number): boolean => {
    let cur = byPid.get(pid)?.parentPid
    while (cur != null) {
      if (candidatePids.has(cur)) return true
      cur = byPid.get(cur)?.parentPid
    }
    return false
  }
  const tops = candidates.filter((c) => !hasAncestorCandidate(c.pid))
  if (tops.length !== 1) return null

  return identifyAgentFromProcess(tops[0].name, tops[0].argv)
}