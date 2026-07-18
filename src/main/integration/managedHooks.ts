/**
 * managedHooks -- pure surgery on an agent hook config for the session-linking + live
 * status feature (spec 047 phase 3/4 + spec 032).
 *
 * This is a deliberate, scoped exception to CLAUDE.md's "do not mutate agent config files"
 * non-negotiable. It is idempotent, versioned, and cleanly uninstallable. The managed hooks
 * run our standalone PowerShell/bash hook script (see assets/), which reports session ids
 * (linking) and lifecycle events (status badges) back to main over a localhost loopback.
 *
 * Claude + Codex: both read hooks from a JSON file with the SAME nested
 * `{ matcher, hooks:[{type:"command",command}] }` shape -- Claude from
 * `~/.claude/settings.json`, Codex from `~/.codex/hooks.json`. (Codex additionally needs
 * `[features] hooks = true` in `~/.codex/config.toml`, handled by codexConfigFeatures.ts.)
 * Because the two live in SEPARATE files, per-file sentinel detection is unambiguous, so
 * the pure functions below are file+kind agnostic.
 *
 * The pure functions operate on a parsed config object so the install/uninstall idempotence
 * and unrelated-hook-preservation invariants can be unit-tested without IO. The IO wrapper
 * (managedHookController.ts) reads/writes the file with a timestamped `.bak` on every change
 * and atomic replacement.
 */

// The hook command invokes our standalone hook script. We detect our managed entry by
// this sentinel substring -- the script basename WITHOUT extension -- so it matches both
// the Windows `multiagent-agent-state.ps1` and the Unix `multiagent-agent-state.sh` command
// strings, and a port/path/kind/event change updates the existing entry in place rather than
// appending a duplicate. The sentinel disambiguates our entries from unrelated hooks under
// ANY event key, so detection/removal generalizes across every event without touching
// unrelated hooks.
export const HOOK_SENTINEL = 'multiagent-agent-state'

/** Single-quote a path for a POSIX shell, escaping any embedded single quotes (herdr-style). */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`
}

/**
 * Build the command string for a managed hook, parameterised by agent kind, event, and
 * platform. The kind is the script's first positional arg; `event` (when present) is the
 * second positional arg (the snake_case lifecycle event the script reports back).
 *
 * - win32: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<path>.ps1" <kind> [<event>]`
 * - Unix:  `bash '<path>.sh' <kind> [<event>]`
 *
 * `event` omitted/undefined -> the legacy no-arg command. This is used for the SessionStart
 * install so its command string stays byte-identical to the 047 install (preserving Codex's
 * persisted `/hooks` trust for SessionStart across the 032 upgrade; only the NEW lifecycle
 * events add an arg and require a fresh trust). `platform` is a seam (defaults to
 * `process.platform`) so the per-platform command shape can be unit-tested on any host.
 */
export function generateHookCommand(
  scriptPath: string,
  kind: 'claude' | 'codex',
  event?: string,
  platform: string = process.platform,
): string {
  const eventArg = event ? ` ${event}` : ''
  if (platform === 'win32') {
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" ${kind}${eventArg}`
  }
  return `bash ${shellSingleQuote(scriptPath)} ${kind}${eventArg}`
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
 * Install or update one of our managed hooks under `eventName` in a parsed agent config,
 * preserving every other key, event, matcher group, and hook entry. Idempotent: a second
 * install updates the existing managed entry under that event (e.g. a new script path or
 * event arg) instead of duplicating.
 *
 * `matcher` controls the group's matcher field:
 *   - `''` (default, Claude): an empty-string matcher matches all sources/tools for that
 *     event (Claude treats `""` as match-all).
 *   - `null` (Codex source/non-matcher events): OMIT the matcher key. Codex does NOT treat
 *     `""` as match-all (an empty matcher matches nothing there, so the hook would be
 *     trusted but never fire); omitting it matches every source. For Codex tool events use
 *     the literal `'.*'` (matches all tool names) -- pass it as `matcher`.
 *   - any other literal (e.g. `'permission_prompt'`, `'.*'`): written verbatim.
 */
export function injectManagedHook(
  config: unknown,
  eventName: string,
  command: string,
  matcher: string | null = '',
): unknown {
  const cfg = (config && typeof config === 'object' ? clone(config as AgentConfig) : {}) as AgentConfig
  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {}
  let groups = cfg.hooks[eventName]
  if (!Array.isArray(groups)) groups = []
  let updated = false
  for (const group of groups) {
    if (!isMatcherGroup(group)) continue
    for (const entry of group.hooks) {
      if (isOurHook(entry)) {
        entry.command = command
        // Reconcile the group matcher to the desired policy, but only when the group holds
        // ONLY our hook -- never clobber the matcher of a group sharing unrelated hooks.
        // (Our install always creates a solo group, so this is the norm.)
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
    groups.push(group)
  }
  cfg.hooks[eventName] = groups
  return cfg
}

/**
 * Remove every one of our managed hooks from a parsed agent config, across ALL event keys
 * (sentinel-based), preserving all unrelated hooks. Empty groups are removed; any event key
 * that becomes empty is dropped; if `hooks` becomes empty the `hooks` object is dropped.
 */
export function removeManagedHook(config: unknown): unknown {
  return pruneManagedHooksImpl(config, () => false)
}

/**
 * Reconcile a parsed agent config to a desired managed event set: remove our managed hooks
 * from every event key NOT in `allowedEventKeys`, preserving unrelated hooks and preserving
 * our entries under allowed keys (those are updated in place by `injectManagedHook`). This is
 * the install-time self-cleaning pass -- it sweeps orphaned entries left by a PRIOR version
 * whose event set has since shrunk (e.g. Codex PostToolUse, dropped in spec 032). Without it,
 * `install` is additive-only and a dropped event lingers until a full uninstall. Within an
 * allowed key there is at most one of our entries (inject is idempotent), so only cross-key
 * orphans need pruning. `removeManagedHook` is the `allowedEventKeys = ∅` special case.
 */
export function pruneManagedHooks(config: unknown, allowedEventKeys: Set<string>): unknown {
  return pruneManagedHooksImpl(config, (eventName) => allowedEventKeys.has(eventName))
}

function pruneManagedHooksImpl(config: unknown, keepKey: (eventName: string) => boolean): unknown {
  if (!config || typeof config !== 'object') return config
  const cfg = clone(config as AgentConfig)
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return cfg
  for (const eventName of Object.keys(cfg.hooks)) {
    if (keepKey(eventName)) continue
    const groups = cfg.hooks[eventName]
    if (!Array.isArray(groups)) continue
    const keptGroups: MatcherGroup[] = []
    for (const group of groups) {
      if (!isMatcherGroup(group)) { keptGroups.push(group); continue }
      const keptHooks = group.hooks.filter((h) => !isOurHook(h))
      if (keptHooks.length > 0) {
        keptGroups.push({ ...group, hooks: keptHooks })
      }
      // else: the group only held our hook(s) -> drop the whole group
    }
    if (keptGroups.length > 0) {
      cfg.hooks[eventName] = keptGroups
    } else {
      delete cfg.hooks[eventName]
    }
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks
  return cfg
}

/** True if a parsed agent config currently holds any of our managed hooks (under any event). */
export function hasManagedHook(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false
  const hooks = (config as AgentConfig).hooks
  if (!hooks || typeof hooks !== 'object') return false
  for (const eventName of Object.keys(hooks)) {
    const groups = hooks[eventName]
    if (!Array.isArray(groups)) continue
    if (groups.some((g) => isMatcherGroup(g) && g.hooks.some(isOurHook))) return true
  }
  return false
}