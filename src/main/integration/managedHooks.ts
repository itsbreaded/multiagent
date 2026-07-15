/**
 * managedHooks — pure surgery on an agent hook config for the session-linking feature
 * (spec 047 phase 3 / phase 4).
 *
 * This is a deliberate, scoped exception to CLAUDE.md's "do not mutate agent config files"
 * non-negotiable. It is idempotent, versioned, and cleanly uninstallable. The managed hook
 * is a single SessionStart entry whose command runs our standalone PowerShell hook script
 * (see assets/), which reports the session id + transcript path back to main over a
 * localhost loopback endpoint.
 *
 * Claude + Codex: both read SessionStart hooks from a JSON file with the SAME nested
 * `{ matcher, hooks:[{type:"command",command}] }` shape — Claude from
 * `~/.claude/settings.json`, Codex from `~/.codex/hooks.json`. (Codex additionally needs
 * `[features] hooks = true` in `~/.codex/config.toml`, handled by codexConfigFeatures.ts.)
 * Because the two live in SEPARATE files, per-file sentinel detection is unambiguous, so
 * the pure functions below are file+kind agnostic.
 *
 * The pure functions operate on a parsed config object so the install/uninstall idempotence
 * and unrelated-hook-preservation invariants can be unit-tested without IO. The IO wrapper
 * (managedHookController.ts) reads/writes the file with a timestamped `.bak` on every
 * change and atomic replacement.
 */

// The hook command invokes our standalone hook script. We detect our managed entry by
// this sentinel substring — the script basename WITHOUT extension — so it matches both the
// Windows `multiagent-agent-state.ps1` and the Unix `multiagent-agent-state.sh` command
// strings, and a port/path/kind change updates the existing entry in place rather than
// appending a duplicate.
export const HOOK_SENTINEL = 'multiagent-agent-state'

/** Single-quote a path for a POSIX shell, escaping any embedded single quotes (herdr-style). */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`
}

/**
 * Build the command string for the managed SessionStart hook, parameterised by agent kind
 * and platform. The kind is passed as the script's first positional arg so the hook script
 * can echo it back in its report (the report server emits a correctly-typed `session:detected`).
 *
 * - win32: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<path>.ps1" <kind>`
 *   (PowerShell ships with Windows; -NoProfile keeps startup fast, -ExecutionPolicy Bypass
 *   lets the script run without per-system signing.)
 * - Unix: `bash '<path>.sh' <kind>` (bash ships with every macOS/Linux desktop; the path is
 *   single-quoted so a userData path containing spaces — e.g. macOS
 *   `~/Library/Application Support/…` — survives shell parsing.)
 *
 * `platform` is a seam (defaults to `process.platform`) so the per-platform command shape
 * can be unit-tested on any host.
 */
export function generateHookCommand(
  scriptPath: string,
  kind: 'claude' | 'codex',
  platform: string = process.platform,
): string {
  if (platform === 'win32') {
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" ${kind}`
  }
  return `bash ${shellSingleQuote(scriptPath)} ${kind}`
}

type HookEntry = { type: string; command: string; args?: unknown[] }
type MatcherGroup = { matcher?: string; hooks: HookEntry[] }
type AgentConfig = Record<string, unknown> & {
  hooks?: Record<string, MatcherGroup[]>
}

function isMatcherGroup(value: unknown): value is MatcherGroup {
  return !!value && typeof value === 'object' && Array.isArray((value as MatcherGroup).hooks)
}

function isOurHook(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' &&
    typeof (entry as HookEntry).command === 'string' &&
    (entry as HookEntry).command.includes(HOOK_SENTINEL)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Install or update our managed SessionStart hook in a parsed agent config, preserving
 * every other key, event, matcher group, and hook entry. Idempotent: a second install
 * updates the existing managed entry (e.g. a new script path/kind) instead of duplicating.
 *
 * `matcher` controls the group's matcher field:
 *   - `''` (default, Claude): an empty-string matcher matches ALL SessionStart sources
 *     (startup|resume|clear|compact) so an in-pane `claude --resume` fork re-reports too.
 *   - `null` (Codex): OMIT the matcher key. Codex does NOT treat `""` as match-all (an
 *     empty matcher matches nothing there, so the hook would be trusted but never fire);
 *     omitting it matches every source — mirroring herdr's `install_codex` (None matcher).
 */
export function injectManagedHook(config: unknown, command: string, matcher: string | null = ''): unknown {
  const cfg = (config && typeof config === 'object' ? clone(config as AgentConfig) : {}) as AgentConfig
  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {}
  let sessionStart = cfg.hooks['SessionStart']
  if (!Array.isArray(sessionStart)) sessionStart = []
  let updated = false
  for (const group of sessionStart) {
    if (!isMatcherGroup(group)) continue
    for (const entry of group.hooks) {
      if (isOurHook(entry)) {
        entry.command = command
        // Reconcile the group matcher to the desired per-kind policy, but only when the
        // group holds ONLY our hook — never clobber the matcher of a group sharing
        // unrelated hooks. (Our install always creates a solo group, so this is the norm.)
        if (group.hooks.every(isOurHook)) {
          if (matcher === null) delete (group as MatcherGroup).matcher
          else (group as MatcherGroup).matcher = matcher
        }
        updated = true
        break
      }
    }
    if (updated) break
  }
  if (!updated) {
    const group: MatcherGroup = matcher === null
      ? { hooks: [{ type: 'command', command }] }
      : { matcher, hooks: [{ type: 'command', command }] }
    sessionStart.push(group)
  }
  cfg.hooks['SessionStart'] = sessionStart
  return cfg
}

/**
 * Remove our managed SessionStart hook from a parsed agent config, preserving all unrelated
 * hooks. Empty SessionStart groups are removed; if SessionStart becomes empty the key is
 * dropped; if hooks becomes empty the hooks object is dropped.
 */
export function removeManagedHook(config: unknown): unknown {
  if (!config || typeof config !== 'object') return config
  const cfg = clone(config as AgentConfig)
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return cfg
  const sessionStart = cfg.hooks['SessionStart']
  if (!Array.isArray(sessionStart)) return cfg

  const keptGroups: MatcherGroup[] = []
  for (const group of sessionStart) {
    if (!isMatcherGroup(group)) { keptGroups.push(group); continue }
    const keptHooks = group.hooks.filter((h) => !isOurHook(h))
    if (keptHooks.length > 0) {
      keptGroups.push({ ...group, hooks: keptHooks })
    }
    // else: the group only held our hook → drop the whole group
  }
  if (keptGroups.length > 0) {
    cfg.hooks['SessionStart'] = keptGroups
  } else {
    delete cfg.hooks['SessionStart']
    if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks
  }
  return cfg
}

/** True if a parsed agent config currently holds our managed hook. */
export function hasManagedHook(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false
  const groups = (config as AgentConfig).hooks?.['SessionStart']
  if (!Array.isArray(groups)) return false
  return groups.some((g) => isMatcherGroup(g) && g.hooks.some(isOurHook))
}

// --- Back-compat aliases (older call sites / tests may reference the Claude name) ---
// These keep the pure semantics identical; they are the same surgery whether the config is
// Claude settings.json or Codex hooks.json.
export const injectClaudeHook = injectManagedHook
export const removeClaudeHook = removeManagedHook
export const hasClaudeHook = hasManagedHook
