/**
 * managedHookController — the IO wrapper around the pure agent-hook surgery in
 * `managedHooks.ts` + the Codex `[features]` surgery in `codexConfigFeatures.ts`
 * (spec 047 phase 3 / phase 4).
 *
 * Manages TWO hook targets that share the same JSON `{ matcher, hooks:[] }` shape:
 *   - Claude → `~/.claude/settings.json` (the user-scope file Claude Code reads hooks from;
 *     NOT `~/.claude.json`, which Claude does not read for hooks).
 *   - Codex  → `~/.codex/hooks.json`, plus `[features] hooks = true` in `~/.codex/config.toml`
 *     (Codex will not run any hook until that feature flag is on).
 *
 * Each install/uninstall preserves every unrelated settings key/hook and the original
 * indentation, writes a timestamped `.bak` on every change, and atomically replaces.
 * Installs are idempotent (update the existing managed entry); uninstalls remove only our
 * entry. On Codex uninstall the `[features] hooks = true` flag is LEFT in place (matches
 * herdr; harmless once the managed hook entry is gone from hooks.json).
 *
 * Stable script path (Codex trust persistence): the hook script is copied to a FIXED
 * user path — `<userData>/multiagent-agent-state.ps1` — at install time and refreshed only
 * when the bundled asset's content changed. Both hook commands point at that fixed path, so
 * the command string is byte-identical across dev / packaged / version bumps and Codex's
 * persisted `/hooks` trust is NOT invalidated (a changed command would revert to untrusted).
 *
 * This is a scoped exception to CLAUDE.md's "no agent config mutation" rule — default-on
 * under phase 4, reversible from the same toggle. Legacy cleanup: an earlier version
 * installed into `~/.claude.json` (which Claude does not read for hooks); on install/uninstall
 * we also remove any stray managed hook from `~/.claude.json` so the user's config is left clean.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeJsonAtomic, writeTextAtomic } from '../atomicJson'
import { timestampForFilename } from '../ipc/layoutStore'
import {
  injectManagedHook,
  removeManagedHook,
  pruneManagedHooks,
  hasManagedHook,
  generateHookCommand,
} from './managedHooks'
import {
  ensureCodexHooksFeatureEnabled,
  codexHooksFeatureEnabled,
} from './codexConfigFeatures'

// Per-agent managed hook event sets (spec 032). Each entry installs one hook entry under
// the agent config's `configKey`, with the given matcher policy, whose command appends
// `scriptArg` as the hook script's 2nd positional arg (the lifecycle event it reports).
// `SessionStart` carries NO scriptArg so its command stays byte-identical to the 047
// install -- preserving Codex's persisted /hooks trust for SessionStart across the 032
// upgrade; only the new lifecycle events add an arg (and require a fresh trust). The
// hook script treats an absent 2nd arg as `session_start` for back-compat.
interface ManagedEvent {
  configKey: string
  matcher: string | null
  scriptArg?: string
}

// Claude: '' matcher = match-all (sources/tools); Notification uses the literal
// 'permission_prompt' matcher. No Codex-only events (Notification/StopFailure are Claude).
const CLAUDE_EVENTS: readonly ManagedEvent[] = [
  { configKey: 'SessionStart', matcher: '' },
  { configKey: 'UserPromptSubmit', matcher: '', scriptArg: 'user_prompt_submit' },
  { configKey: 'PreToolUse', matcher: '', scriptArg: 'pre_tool_use' },
  { configKey: 'PostToolUse', matcher: '', scriptArg: 'post_tool_use' },
  { configKey: 'Notification', matcher: 'permission_prompt', scriptArg: 'permission_request' },
  { configKey: 'Stop', matcher: '', scriptArg: 'stop' },
  { configKey: 'StopFailure', matcher: '', scriptArg: 'stop_failure' },
]

// Codex: null matcher = OMIT the key (Codex treats '' as match-nothing for source events);
// PreToolUse uses '.*' to match all tool names. No Notification (not a Codex hook) and no
// StopFailure (does not exist) -- a failed Codex turn shows idle (honest fallback).
// PostToolUse is intentionally omitted for Codex: the reducer treats pre/post tool use
// identically (both -> working with the tool name), and Stop clears it, so PostToolUse
// changes no badge state. Each Codex hook fire also prints a "running <hook>" TUI status
// line, so dropping the redundant PostToolUse cuts ~half those announcements with no status
// loss. Claude keeps PostToolUse (different surface, no such TUI noise). See spec 032.
const CODEX_EVENTS: readonly ManagedEvent[] = [
  { configKey: 'SessionStart', matcher: null },
  { configKey: 'UserPromptSubmit', matcher: null, scriptArg: 'user_prompt_submit' },
  { configKey: 'PreToolUse', matcher: '.*', scriptArg: 'pre_tool_use' },
  { configKey: 'PermissionRequest', matcher: '.*', scriptArg: 'permission_request' },
  { configKey: 'Stop', matcher: null, scriptArg: 'stop' },
]

export interface ManagedHookControllerDeps {
  /** Path to the user-scope Claude settings file (~/.claude/settings.json). */
  claudeSettingsPath: string
  /** Path to the user-scope Codex hooks file (~/.codex/hooks.json). */
  codexHooksPath: string
  /** Path to the Codex config file (~/.codex/config.toml) for the [features] flag. */
  codexConfigPath: string
  /** Path to the legacy ~/.claude.json (cleaned up only; never installed into). */
  legacyClaudeConfigPath?: string
  /** userData dir; the stable hook-script copy lives here for Codex trust persistence. */
  userDataDir: string
  /** Path to the bundled hook script asset (beside out/main). Copied into userDataDir. */
  sourceHookScriptPath: string
}

export class ManagedHookController {
  constructor(private deps: ManagedHookControllerDeps) {}

  /** Absolute path to ~/.claude/settings.json (overridable for tests via deps). */
  static defaultClaudeSettingsPath(): string {
    return path.join(os.homedir(), '.claude', 'settings.json')
  }

  /** Absolute path to ~/.codex/hooks.json. */
  static defaultCodexHooksPath(): string {
    return path.join(os.homedir(), '.codex', 'hooks.json')
  }

  /** Absolute path to ~/.codex/config.toml. */
  static defaultCodexConfigPath(): string {
    return path.join(os.homedir(), '.codex', 'config.toml')
  }

  /** Absolute path to ~/.claude.json (legacy cleanup target). */
  static legacyClaudeConfigPath(): string {
    return path.join(os.homedir(), '.claude.json')
  }

  /** The hook-script filename for a platform: `.ps1` on Windows, `.sh` on Unix. */
  static hookScriptBasename(platform: string = process.platform): string {
    return platform === 'win32' ? 'multiagent-agent-state.ps1' : 'multiagent-agent-state.sh'
  }

  /** Resolve the bundled hook script path: beside out/main, then a couple of dev fallbacks. */
  static resolveHookScriptPath(): string {
    const basename = ManagedHookController.hookScriptBasename()
    const candidates = [
      path.join(__dirname, basename),
      path.join(__dirname, '..', basename),
      path.join(process.cwd(), 'src', 'main', 'integration', 'assets', basename),
    ]
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c } catch { /* try next */ }
    }
    return candidates[0]
  }

  /** The fixed, stable install location for the hook script (inside userData). */
  installedScriptPath(): string {
    return path.join(this.deps.userDataDir, ManagedHookController.hookScriptBasename())
  }

  /** True if BOTH managed hooks are currently installed (Claude + Codex). */
  isInstalled(): boolean {
    return (
      hasManagedHook(this.readConfig(this.deps.claudeSettingsPath)) &&
      hasManagedHook(this.readConfig(this.deps.codexHooksPath))
    )
  }

  install(): void {
    this.refreshInstalledScript()
    const scriptPath = this.installedScriptPath()
    // Install every event in the per-agent set under its own config key. SessionStart is
    // installed with no scriptArg (legacy command string, preserves Codex trust); the rest
    // append their snake_case scriptArg. Idempotent: injectManagedHook updates an existing
    // managed entry in place rather than duplicating.
    this.writeJsonConfig(this.deps.claudeSettingsPath, (cfg) => {
      // Reconcile first: drop managed entries from event keys no longer in the desired set
      // (orphans left by a prior version), then inject/update the current set. Idempotent --
      // a steady-state install produces a byte-identical config and writeJsonConfig skips.
      let next = pruneManagedHooks(cfg, new Set(CLAUDE_EVENTS.map((e) => e.configKey)))
      for (const ev of CLAUDE_EVENTS) {
        next = injectManagedHook(next, ev.configKey, generateHookCommand(scriptPath, 'claude', ev.scriptArg), ev.matcher)
      }
      return next
    })
    this.writeJsonConfig(this.deps.codexHooksPath, (cfg) => {
      let next = pruneManagedHooks(cfg, new Set(CODEX_EVENTS.map((e) => e.configKey)))
      for (const ev of CODEX_EVENTS) {
        next = injectManagedHook(next, ev.configKey, generateHookCommand(scriptPath, 'codex', ev.scriptArg), ev.matcher)
      }
      return next
    })
    this.ensureCodexFeaturesEnabled()
    // Always clean up a stray managed hook from the legacy ~/.claude.json location.
    this.cleanupLegacy()
  }
  uninstall(): void {
    this.writeJsonConfig(this.deps.claudeSettingsPath, (cfg) =>
      hasManagedHook(cfg) ? removeManagedHook(cfg) : cfg,
    )
    this.writeJsonConfig(this.deps.codexHooksPath, (cfg) =>
      hasManagedHook(cfg) ? removeManagedHook(cfg) : cfg,
    )
    // [features] hooks = true is intentionally LEFT (matches herdr; harmless without the hook).
    this.cleanupLegacy()
  }

  /**
   * Copy the bundled hook script into the fixed userData location, but only when it is
   * missing or its content differs from the bundled asset. Keeping the copy byte-stable
   * avoids invalidating Codex's persisted `/hooks` trust on every launch / version bump.
   */
  private refreshInstalledScript(): void {
    const dest = this.installedScriptPath()
    try {
      const sourceText = fs.readFileSync(this.deps.sourceHookScriptPath, 'utf8')
      let existing: string | null = null
      try { existing = fs.readFileSync(dest, 'utf8') } catch { /* not installed yet */ }
      if (existing === sourceText) return
      try { fs.mkdirSync(this.deps.userDataDir, { recursive: true }) } catch { /* may already exist */ }
      fs.writeFileSync(dest, sourceText)
    } catch (err) {
      // If the bundled asset can't be read (e.g. missing in a dev tree), fall back to it
      // as the command target — the controller still functions, just without the stable copy.
      console.warn('[MultiAgent] managed hook script refresh failed:', err)
    }
  }

  /** Ensure `[features] hooks = true` in the Codex config.toml (idempotent, with .bak). */
  private ensureCodexFeaturesEnabled(): void {
    const filePath = this.deps.codexConfigPath
    let raw = ''
    try { raw = fs.readFileSync(filePath, 'utf8') } catch { /* file may not exist yet */ }
    if (codexHooksFeatureEnabled(raw)) return
    const next = ensureCodexHooksFeatureEnabled(raw)
    // Back up the existing file before mutating it (only if it existed).
    if (raw.length > 0) {
      try { fs.copyFileSync(filePath, `${filePath}.bak.${timestampForFilename()}`) }
      catch (err) { console.warn('[MultiAgent] codex config.toml .bak failed:', err) }
    } else {
      try { fs.mkdirSync(path.dirname(filePath), { recursive: true }) } catch { /* may exist */ }
    }
    try { writeTextAtomic(filePath, next) }
    catch (err) { console.warn('[MultiAgent] codex config.toml write failed:', err) }
  }

  /** Remove any managed hook left in ~/.claude.json by an earlier version. */
  private cleanupLegacy(): void {
    const legacy = this.deps.legacyClaudeConfigPath
    if (!legacy) return
    const config = this.readConfig(legacy)
    if (!hasManagedHook(config)) return
    this.writeJsonConfig(legacy, (cfg) => removeManagedHook(cfg))
  }

  private readConfig(filePath: string): unknown {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(raw)
    } catch {
      // Missing or unparseable config → start from an empty object (install creates it).
      return {}
    }
  }

  /**
   * Read → transform → write a JSON config file. Writes a `.bak` of the original and
   * atomically replaces, but ONLY when the transform produced a change (idempotent
   * reinstall must not touch the user's file on every startup).
   */
  private writeJsonConfig(filePath: string, transform: (cfg: unknown) => unknown): void {
    let raw: string | null = null
    let parsed: unknown = {}
    try {
      raw = fs.readFileSync(filePath, 'utf8')
      parsed = JSON.parse(raw)
    } catch { /* missing/unparseable → start from {} */ }
    const indent = this.detectIndent(raw)
    const next = transform(parsed)
    if (JSON.stringify(next) === JSON.stringify(parsed)) return
    if (raw !== null) {
      try { fs.copyFileSync(filePath, `${filePath}.bak.${timestampForFilename()}`) }
      catch (err) { console.warn('[MultiAgent] managed hook .bak failed:', err) }
    } else {
      try { fs.mkdirSync(path.dirname(filePath), { recursive: true }) } catch { /* may exist */ }
    }
    writeJsonAtomic(filePath, next, indent)
  }

  /** Detect the original file's indentation (2 or 4 spaces) to preserve formatting. */
  private detectIndent(raw: string | null): number {
    if (!raw) return 2
    const match = raw.match(/\n( +)"[A-Za-z0-9_-]+":/)
    if (match) return match[1].length === 4 ? 4 : 2
    return 2
  }
}
