import { describe, it, expect } from 'vitest'
import {
  injectManagedHook,
  removeManagedHook,
  hasManagedHook,
  generateHookCommand,
  HOOK_SENTINEL,
} from './managedHooks'

// Spec 047 phase 3 / phase 4: pure agent hook config surgery. The same JSON shape is used
// for Claude (~/.claude/settings.json) and Codex (~/.codex/hooks.json), so the functions
// are file+kind agnostic. Non-negotiables under test: idempotent install, unrelated-hook
// preservation, clean uninstall, that we touch only hooks.SessionStart, and that the kind
// arg is baked into the command.

const CMD = generateHookCommand(`/app/${HOOK_SENTINEL}.ps1`, 'claude', 'win32')

describe('generateHookCommand', () => {
  it('win32: uses powershell -File and appends the kind', () => {
    expect(generateHookCommand(`/app/${HOOK_SENTINEL}.ps1`, 'codex', 'win32')).toBe(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "/app/${HOOK_SENTINEL}.ps1" codex`,
    )
  })
  it('unix: uses bash with a single-quoted path and appends the kind', () => {
    expect(generateHookCommand(`/app/${HOOK_SENTINEL}.sh`, 'codex', 'linux')).toBe(
      `bash '/app/${HOOK_SENTINEL}.sh' codex`,
    )
  })
  it('unix: single-quotes survive a userData path with a space (macOS)', () => {
    const macPath = `/Users/me/Library/Application Support/MultiAgent/${HOOK_SENTINEL}.sh`
    expect(generateHookCommand(macPath, 'claude', 'darwin')).toBe(`bash '${macPath}' claude`)
  })
  it('unix: escapes an embedded single quote in the path', () => {
    expect(generateHookCommand(`/odd'name/${HOOK_SENTINEL}.sh`, 'claude', 'linux')).toBe(
      `bash '/odd'\"'\"'name/${HOOK_SENTINEL}.sh' claude`,
    )
  })
  it('includes the claude kind', () => {
    expect(CMD).toContain(' claude')
  })
})

describe('managedHook — install', () => {
  it('adds a SessionStart group to an empty config (default "" matcher for Claude)', () => {
    const out = injectManagedHook({}, CMD) as { hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } }
    expect(out.hooks.SessionStart).toHaveLength(1)
    expect(out.hooks.SessionStart[0].matcher).toBe('')
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe(CMD)
  })

  it('omits the matcher key for Codex (null) — empty matcher would not fire in Codex', () => {
    const codexCmd = generateHookCommand(`C:\\app\\${HOOK_SENTINEL}`, 'codex')
    const out = injectManagedHook({}, codexCmd, null) as { hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } }
    expect(out.hooks.SessionStart).toHaveLength(1)
    expect(out.hooks.SessionStart[0].matcher).toBeUndefined()
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe(codexCmd)
  })

  it('updates an existing entry matcher to omitted when reinstalled for Codex', () => {
    // Simulate a prior install that used the empty-string matcher (the bug).
    const prior = injectManagedHook({}, CMD, '') as { hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } }
    expect(prior.hooks.SessionStart[0].matcher).toBe('')
    const codexCmd = generateHookCommand(`C:\\app\\${HOOK_SENTINEL}`, 'codex')
    const out = injectManagedHook(prior, codexCmd, null) as { hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } }
    expect(out.hooks.SessionStart).toHaveLength(1)
    expect(out.hooks.SessionStart[0].matcher).toBeUndefined()
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe(codexCmd)
  })

  it('preserves unrelated top-level keys and other hook events', () => {
    const config = {
      someSetting: true,
      hooks: {
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user-prompt' }] }],
      },
    }
    const out = injectManagedHook(config, CMD) as { someSetting: boolean; hooks: Record<string, unknown> }
    expect(out.someSetting).toBe(true)
    expect(out.hooks['UserPromptSubmit']).toEqual(config.hooks.UserPromptSubmit)
    expect(hasManagedHook(out)).toBe(true)
  })

  it('preserves an existing unrelated SessionStart group and appends ours', () => {
    const config = {
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'load-context.sh' }] }],
      },
    }
    const out = injectManagedHook(config, CMD) as { hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }
    expect(out.hooks.SessionStart).toHaveLength(2)
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe('load-context.sh') // untouched
    expect(out.hooks.SessionStart[1].hooks[0].command).toBe(CMD)
  })

  it('is idempotent: a second install updates the existing entry instead of duplicating', () => {
    const once = injectManagedHook({}, CMD)
    const newCmd = generateHookCommand(`C:\\elsewhere\\${HOOK_SENTINEL}`, 'codex')
    const twice = injectManagedHook(once, newCmd) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }
    expect(twice.hooks.SessionStart).toHaveLength(1)
    expect(twice.hooks.SessionStart[0].hooks).toHaveLength(1)
    expect(twice.hooks.SessionStart[0].hooks[0].command).toBe(newCmd)
  })

  it('does not mutate the input config', () => {
    const config = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'x' }] }] } }
    const snap = JSON.stringify(config)
    injectManagedHook(config, CMD)
    expect(JSON.stringify(config)).toBe(snap)
  })
})

describe('managedHook — uninstall', () => {
  it('removes only our hook and leaves unrelated SessionStart groups intact', () => {
    const installed = injectManagedHook({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'load-context.sh' }] }] },
    }, CMD)
    const out = removeManagedHook(installed) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }
    expect(hasManagedHook(out)).toBe(false)
    expect(out.hooks.SessionStart).toHaveLength(1)
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe('load-context.sh')
  })

  it('drops the SessionStart key when only our hook was present', () => {
    const installed = injectManagedHook({}, CMD)
    const out = removeManagedHook(installed) as Record<string, unknown>
    expect(hasManagedHook(out)).toBe(false)
    expect((out as { hooks?: unknown }).hooks).toBeUndefined()
  })

  it('preserves unrelated hook events on uninstall', () => {
    const installed = injectManagedHook({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo x' }] }] },
    }, CMD)
    const out = removeManagedHook(installed) as { hooks: Record<string, unknown> }
    expect(out.hooks['UserPromptSubmit']).toBeDefined()
  })

  it('is a no-op when our hook is not present', () => {
    const config = { hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo x' }] }] } }
    const out = removeManagedHook(config)
    expect(out).toEqual(config)
  })
})