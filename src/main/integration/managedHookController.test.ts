import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ManagedHookController } from './managedHookController'
import {
  HOOK_SENTINEL,
  hasManagedHook,
  injectManagedHook,
  generateHookCommand,
} from './managedHooks'
import { codexHooksFeatureEnabled } from './codexConfigFeatures'

// Spec 047 phase 3 / phase 4: the IO wrapper around the pure surgery. Exercises real fs on
// temp config files. Claude + Codex install/uninstall, idempotent (no-op skip),
// unrelated-key preservation, .bak on change, clean uninstall, legacy ~/.claude.json
// cleanup, the fixed userData script copy, and the Codex config.toml [features] flag.

const SCRIPT_BODY = '# test hook\nexit 0\n'

function uniq(label: string, ext: string): string {
  return path.join(os.tmpdir(), `ma-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
}

interface Fixture {
  settingsPath: string
  codexHooksPath: string
  codexConfigPath: string
  legacyPath: string
  userDataDir: string
  sourceScriptPath: string
  installedScriptPath: string
}

function makeFixture(): Fixture {
  // Unique userData dir so the installed script copy is isolated per test. Use the
  // platform-appropriate script basename so the fixture's installedScriptPath matches
  // what the controller's installedScriptPath() actually produces.
  const basename = ManagedHookController.hookScriptBasename()
  // Unique userData dir so the installed script copy is isolated per test.
  const userDataDir = path.join(os.tmpdir(), `ma-ud-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(userDataDir, { recursive: true })
  const sourceScriptPath = path.join(userDataDir, `src-${basename}`)
  fs.writeFileSync(sourceScriptPath, SCRIPT_BODY)
  return {
    settingsPath: uniq('settings', 'json'),
    codexHooksPath: uniq('codex-hooks', 'json'),
    codexConfigPath: uniq('codex-config', 'toml'),
    legacyPath: uniq('legacy', 'json'),
    userDataDir,
    sourceScriptPath,
    installedScriptPath: path.join(userDataDir, basename),
  }
}

function mkCtrl(f: Fixture, extra: Partial<ConstructorParameters<typeof ManagedHookController>[0]> = {}): ManagedHookController {
  return new ManagedHookController({
    claudeSettingsPath: f.settingsPath,
    codexHooksPath: f.codexHooksPath,
    codexConfigPath: f.codexConfigPath,
    legacyClaudeConfigPath: f.legacyPath,
    userDataDir: f.userDataDir,
    sourceHookScriptPath: f.sourceScriptPath,
    ...extra,
  })
}

function cleanupDir(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry)
      const st = fs.statSync(p)
      if (st.isDirectory()) cleanupDir(p)
      else fs.rmSync(p, { force: true })
    }
  } catch { /* ignore */ }
}

function cleanupFile(p: string): void {
  try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
  try {
    const dir = path.dirname(p)
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(p) + '.bak'))) {
      fs.rmSync(path.join(dir, f), { force: true })
    }
  } catch { /* ignore */ }
}

describe('ManagedHookController (IO)', () => {
  let f: Fixture

  beforeEach(() => { f = makeFixture() })
  afterEach(() => {
    cleanupFile(f.settingsPath)
    cleanupFile(f.codexHooksPath)
    cleanupFile(f.codexConfigPath)
    cleanupFile(f.legacyPath)
    cleanupDir(f.userDataDir)
    try { fs.rmSync(f.userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('installs the hook into both Claude + Codex, copies the stable script, enables the [features] flag', () => {
    const ctrl = mkCtrl(f)
    ctrl.install()

    expect(fs.existsSync(f.installedScriptPath)).toBe(true)
    expect(fs.readFileSync(f.installedScriptPath, 'utf8')).toBe(SCRIPT_BODY)

    const claude = JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))
    expect(hasManagedHook(claude)).toBe(true)
    // Claude command points at the stable userData script and carries the claude kind arg.
    const claudeCmd = claude.hooks.SessionStart.find((g: { hooks: { command: string }[] }) =>
      g.hooks.some((h) => h.command.includes(HOOK_SENTINEL)))?.hooks[0]?.command ?? ''
    expect(claudeCmd).toContain(path.basename(f.installedScriptPath))
    expect(claudeCmd).toContain(' claude')
    expect(claudeCmd).not.toContain(' codex')

    const codex = JSON.parse(fs.readFileSync(f.codexHooksPath, 'utf8'))
    expect(hasManagedHook(codex)).toBe(true)
    const codexCmd = codex.hooks.SessionStart.find((g: { hooks: { command: string }[] }) =>
      g.hooks.some((h) => h.command.includes(HOOK_SENTINEL)))?.hooks[0]?.command ?? ''
    expect(codexCmd).toContain(path.basename(f.installedScriptPath))
    expect(codexCmd).toContain(' codex')

    expect(codexHooksFeatureEnabled(fs.readFileSync(f.codexConfigPath, 'utf8'))).toBe(true)
  })

  it('installs the full per-agent lifecycle event set (spec 032), SessionStart arg-less, others arg-ful', () => {
    const ctrl = mkCtrl(f)
    ctrl.install()
    const claude = JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))
    const codex = JSON.parse(fs.readFileSync(f.codexHooksPath, 'utf8'))
    const base = path.basename(f.installedScriptPath)
    type HookCfg = { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const ourCmds = (cfg: HookCfg): string[] => {
      const out: string[] = []
      for (const key of Object.keys(cfg.hooks ?? {})) {
        for (const g of cfg.hooks![key]) for (const h of g.hooks) if (h.command.includes(HOOK_SENTINEL)) out.push(h.command)
      }
      return out
    }
    // Claude: 7 events; Codex: 5 events (no Notification/StopFailure/PostToolUse -- the
    // last is intentionally omitted: pre/post tool use are reducer-identical, so PostToolUse
    // changes no badge state and only adds Codex TUI "running" noise; see spec 032).
    expect(ourCmds(claude)).toHaveLength(7)
    expect(ourCmds(codex)).toHaveLength(5)
    // SessionStart stays arg-less (byte-identical to 047, preserves Codex trust). Build the
    // expected command via the same helper the controller uses (defaults to process.platform),
    // so the assertion is portable across the win/mac/linux CI runners.
    const claudeSS = claude.hooks.SessionStart.find((g: { hooks: { command: string }[] }) => g.hooks.some((h) => h.command.includes(HOOK_SENTINEL)))!.hooks[0].command
    expect(claudeSS).toBe(generateHookCommand(f.installedScriptPath, 'claude'))
    // A lifecycle event carries its snake_case arg + points at the stable script.
    const claudePre = claude.hooks.PreToolUse.find((g: { hooks: { command: string }[] }) => g.hooks.some((h) => h.command.includes(HOOK_SENTINEL)))!.hooks[0].command
    expect(claudePre).toContain(base)
    expect(claudePre).toContain(' claude pre_tool_use')
    // Claude Notification uses the permission_prompt matcher; Codex PermissionRequest exists.
    expect(claude.hooks.Notification[0].matcher).toBe('permission_prompt')
    expect(codex.hooks.PermissionRequest).toBeDefined()
    expect(codex.hooks.PermissionRequest[0].matcher).toBe('.*')
    // Codex has no Notification / StopFailure.
    expect(codex.hooks.Notification).toBeUndefined()
    expect(codex.hooks.StopFailure).toBeUndefined()
    // Uninstall removes every managed entry across all event keys; unrelated hooks remain.
    ctrl.uninstall()
    expect(hasManagedHook(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')))).toBe(false)
    expect(hasManagedHook(JSON.parse(fs.readFileSync(f.codexHooksPath, 'utf8')))).toBe(false)
  })

  it('is idempotent: a second install does not rewrite the hook files', () => {
    const ctrl = mkCtrl(f)
    ctrl.install()
    const claudeBefore = fs.readFileSync(f.settingsPath, 'utf8')
    const codexBefore = fs.readFileSync(f.codexHooksPath, 'utf8')
    const configBefore = fs.readFileSync(f.codexConfigPath, 'utf8')
    ctrl.install()
    expect(fs.readFileSync(f.settingsPath, 'utf8')).toBe(claudeBefore)
    expect(fs.readFileSync(f.codexHooksPath, 'utf8')).toBe(codexBefore)
    expect(fs.readFileSync(f.codexConfigPath, 'utf8')).toBe(configBefore)
  })

  it('reconciles on install: an orphaned managed event from a prior version is removed', () => {
    // Seed a Codex hooks.json as a PRIOR version left it: the full current set PLUS a managed
    // PostToolUse that the current CODEX_EVENTS no longer includes (dropped in spec 032).
    const staleCmd = generateHookCommand(f.installedScriptPath, 'codex', 'post_tool_use')
    const prior = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: generateHookCommand(f.installedScriptPath, 'codex') }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: generateHookCommand(f.installedScriptPath, 'codex', 'user_prompt_submit') }] }],
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: generateHookCommand(f.installedScriptPath, 'codex', 'pre_tool_use') }] }],
        PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: staleCmd }] }],
        PermissionRequest: [{ matcher: '.*', hooks: [{ type: 'command', command: generateHookCommand(f.installedScriptPath, 'codex', 'permission_request') }] }],
        Stop: [{ hooks: [{ type: 'command', command: generateHookCommand(f.installedScriptPath, 'codex', 'stop') }] }],
      },
    }
    fs.writeFileSync(f.codexHooksPath, JSON.stringify(prior))
    const ctrl = mkCtrl(f)
    ctrl.install()
    const codex = JSON.parse(fs.readFileSync(f.codexHooksPath, 'utf8'))
    // The orphaned PostToolUse key is gone; the current 5-event set is intact.
    expect(codex.hooks.PostToolUse).toBeUndefined()
    expect(codex.hooks.SessionStart).toBeDefined()
    expect(codex.hooks.PermissionRequest).toBeDefined()
    // No managed command anywhere references post_tool_use anymore.
    const cmds = JSON.stringify(codex)
    expect(cmds).not.toContain('post_tool_use')
  })

  it('refreshes the stable script only when the bundled content changed', () => {
    const ctrl = mkCtrl(f)
    ctrl.install()
    const firstMtime = fs.statSync(f.installedScriptPath).mtimeMs
    // Re-install with identical source → no rewrite.
    ctrl.install()
    expect(fs.statSync(f.installedScriptPath).mtimeMs).toBe(firstMtime)
    // Change the bundled source → refresh.
    fs.writeFileSync(f.sourceScriptPath, '# new body\nexit 0\n')
    ctrl.install()
    expect(fs.readFileSync(f.installedScriptPath, 'utf8')).toBe('# new body\nexit 0\n')
  })

  it('preserves unrelated settings/hooks and writes a .bak when the command changes', () => {
    const original = {
      theme: 'dark',
      permissions: { allow: ['Bash(*)'] },
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo x' }] }] },
    }
    fs.writeFileSync(f.settingsPath, JSON.stringify(original, null, 2))
    const ctrl = mkCtrl(f)
    ctrl.install()
    const parsed = JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))
    expect(parsed.theme).toBe('dark')
    expect(parsed.permissions).toEqual(original.permissions)
    // The unrelated UserPromptSubmit group is preserved; our managed entry is added
    // alongside it (spec 032 installs a managed UserPromptSubmit hook too).
    expect(parsed.hooks.UserPromptSubmit).toContainEqual(original.hooks.UserPromptSubmit[0])
    expect(hasManagedHook(parsed)).toBe(true)
    const baks = fs.readdirSync(path.dirname(f.settingsPath)).filter((x) => x.startsWith(path.basename(f.settingsPath) + '.bak'))
    expect(baks.length).toBeGreaterThanOrEqual(1)
  })

  it('uninstalls cleanly from both files, leaving unrelated hooks intact and [features] enabled', () => {
    fs.writeFileSync(f.settingsPath, JSON.stringify({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo x' }] }] },
    }))
    fs.writeFileSync(f.codexHooksPath, JSON.stringify({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo y' }] }] },
    }))
    const ctrl = mkCtrl(f)
    ctrl.install()
    ctrl.uninstall()
    const claude = JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))
    expect(hasManagedHook(claude)).toBe(false)
    expect(claude.hooks.UserPromptSubmit).toBeDefined()
    const codex = JSON.parse(fs.readFileSync(f.codexHooksPath, 'utf8'))
    expect(hasManagedHook(codex)).toBe(false)
    expect(codex.hooks.UserPromptSubmit).toBeDefined()
    // [features] hooks = true is intentionally left on uninstall.
    expect(codexHooksFeatureEnabled(fs.readFileSync(f.codexConfigPath, 'utf8'))).toBe(true)
  })

  it('uninstall is a no-op (no rewrite) when our hook is not present', () => {
    fs.writeFileSync(f.settingsPath, JSON.stringify({ theme: 'dark' }))
    const mtimeBefore = fs.statSync(f.settingsPath).mtimeMs
    const ctrl = mkCtrl(f)
    ctrl.uninstall()
    expect(fs.statSync(f.settingsPath).mtimeMs).toBe(mtimeBefore)
  })

  it('isInstalled() reflects both targets', () => {
    const ctrl = mkCtrl(f)
    expect(ctrl.isInstalled()).toBe(false)
    ctrl.install()
    expect(ctrl.isInstalled()).toBe(true)
    ctrl.uninstall()
    expect(ctrl.isInstalled()).toBe(false)
  })

  it('cleans up a stray managed hook from the legacy ~/.claude.json on install', () => {
    const stableCmd = generateHookCommand(f.installedScriptPath, 'claude')
    fs.writeFileSync(f.legacyPath, JSON.stringify(injectManagedHook({ theme: 'dark' }, 'SessionStart', stableCmd)))
    const ctrl = mkCtrl(f)
    ctrl.install()
    const legacyParsed = JSON.parse(fs.readFileSync(f.legacyPath, 'utf8'))
    expect(hasManagedHook(legacyParsed)).toBe(false)
    expect(legacyParsed.theme).toBe('dark')
    const settingsParsed = JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))
    expect(hasManagedHook(settingsParsed)).toBe(true)
  })

  it('cleans up the legacy hook on uninstall too', () => {
    const stableCmd = generateHookCommand(f.installedScriptPath, 'claude')
    fs.writeFileSync(f.legacyPath, JSON.stringify(injectManagedHook({}, 'SessionStart', stableCmd)))
    const ctrl = mkCtrl(f)
    ctrl.uninstall()
    expect(hasManagedHook(JSON.parse(fs.readFileSync(f.legacyPath, 'utf8')))).toBe(false)
  })
})
