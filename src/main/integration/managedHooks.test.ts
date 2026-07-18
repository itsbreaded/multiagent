import { describe, it, expect } from 'vitest'
import {
  HOOK_SENTINEL,
  injectManagedHook,
  removeManagedHook,
  pruneManagedHooks,
  hasManagedHook,
  generateHookCommand,
} from './managedHooks'

// Pure surgery on an agent hook config (spec 047 + spec 032). Verifies the invariants that
// make the managed-hook install safe: we touch only our own entries (sentinel-based), we
// preserve every unrelated key/event/group/hook, install is idempotent, uninstall is clean,
// and the per-event matcher policy (Claude '' / Codex omitted / literal matchers) is right.

const PS1 = `/app/${HOOK_SENTINEL}.ps1`
const SH = `/app/${HOOK_SENTINEL}.sh`

describe('generateHookCommand', () => {
  it('win32: no event -> legacy no-arg command (byte-identical to the 047 install)', () => {
    expect(generateHookCommand(PS1, 'claude', undefined, 'win32')).toBe(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${PS1}" claude`,
    )
  })

  it('win32: with event -> appends the snake_case event as the 2nd positional arg', () => {
    expect(generateHookCommand(PS1, 'codex', 'pre_tool_use', 'win32')).toBe(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${PS1}" codex pre_tool_use`,
    )
  })

  it('linux: no event -> bash single-quoted path + kind', () => {
    expect(generateHookCommand(SH, 'codex', undefined, 'linux')).toBe(`bash '${SH}' codex`)
  })

  it('linux: with event -> appends the event arg', () => {
    expect(generateHookCommand(SH, 'claude', 'stop', 'linux')).toBe(`bash '${SH}' claude stop`)
  })

  it('darwin: single-quotes a path containing spaces', () => {
    const macPath = `/Users/me/Library/Application Support/multiagent/${HOOK_SENTINEL}.sh`
    expect(generateHookCommand(macPath, 'claude', undefined, 'darwin')).toBe(`bash '${macPath}' claude`)
  })

  it('escapes embedded single quotes in the path', () => {
    expect(generateHookCommand(`/odd'name/${HOOK_SENTINEL}.sh`, 'claude', undefined, 'linux')).toBe(
      `bash '/odd'"'"'name/${HOOK_SENTINEL}.sh' claude`,
    )
  })

  it('defaults platform to process.platform when omitted', () => {
    // Smoke: the 2-arg (no event) and 3-arg (event) forms resolve a platform without throwing.
    expect(typeof generateHookCommand(PS1, 'claude')).toBe('string')
    expect(typeof generateHookCommand(PS1, 'claude', 'stop')).toBe('string')
  })
})

describe('injectManagedHook', () => {
  const CMD = generateHookCommand(PS1, 'claude', undefined, 'win32')

  it('adds a group under the given event key to an empty config (default "" matcher)', () => {
    const out = injectManagedHook({}, 'SessionStart', CMD) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } }
    expect(out.hooks.SessionStart).toHaveLength(1)
    expect(out.hooks.SessionStart[0].matcher).toBe('')
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe(CMD)
  })

  it('omits the matcher key for Codex (null) -- empty matcher would not fire in Codex', () => {
    const codexCmd = generateHookCommand(`C:\\app\\${HOOK_SENTINEL}`, 'codex', undefined, 'win32')
    const out = injectManagedHook({}, 'SessionStart', codexCmd, null) as {
      hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } }
    expect(out.hooks.SessionStart[0].matcher).toBeUndefined()
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe(codexCmd)
  })

  it('writes a literal matcher verbatim (Claude Notification permission_prompt / Codex .*)', () => {
    const cmd = generateHookCommand(PS1, 'claude', 'permission_request', 'win32')
    const out = injectManagedHook({}, 'Notification', cmd, 'permission_prompt') as {
      hooks: { Notification: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }
    expect(out.hooks.Notification[0].matcher).toBe('permission_prompt')
    expect(out.hooks.Notification[0].hooks[0].command).toBe(cmd)

    const codexCmd = generateHookCommand(PS1, 'codex', 'pre_tool_use', 'win32')
    const codex = injectManagedHook({}, 'PreToolUse', codexCmd, '.*') as {
      hooks: { PreToolUse: Array<{ matcher: string }> } }
    expect(codex.hooks.PreToolUse[0].matcher).toBe('.*')
  })

  it('updates an existing managed entry in place under the same event (idempotent)', () => {
    const once = injectManagedHook({}, 'SessionStart', CMD)
    const newCmd = generateHookCommand(`C:\\elsewhere\\${HOOK_SENTINEL}`, 'codex', undefined, 'win32')
    const twice = injectManagedHook(once, 'SessionStart', newCmd) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }
    expect(twice.hooks.SessionStart).toHaveLength(1)
    expect(twice.hooks.SessionStart[0].hooks).toHaveLength(1)
    expect(twice.hooks.SessionStart[0].hooks[0].command).toBe(newCmd)
  })

  it('reconciles the matcher to omitted when reinstalled for Codex on an existing entry', () => {
    const prior = injectManagedHook({}, 'SessionStart', CMD, '') as {
      hooks: { SessionStart: Array<{ matcher?: string }> } }
    expect(prior.hooks.SessionStart[0].matcher).toBe('')
    const codexCmd = generateHookCommand(`C:\\app\\${HOOK_SENTINEL}`, 'codex', undefined, 'win32')
    const out = injectManagedHook(prior, 'SessionStart', codexCmd, null) as {
      hooks: { SessionStart: Array<{ matcher?: string }> } }
    expect(out.hooks.SessionStart).toHaveLength(1)
    expect(out.hooks.SessionStart[0].matcher).toBeUndefined()
  })

  it('preserves unrelated top-level keys and unrelated events', () => {
    const config = {
      someSetting: true,
      hooks: {
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user-prompt' }] }],
      },
    }
    const out = injectManagedHook(config, 'SessionStart', CMD) as {
      someSetting: boolean; hooks: Record<string, unknown> }
    expect(out.someSetting).toBe(true)
    expect((out.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command)
      .toBe('echo user-prompt')
    expect(out.hooks.SessionStart).toBeDefined()
  })

  it('preserves an existing unrelated group under the SAME event and appends ours', () => {
    const config = {
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'load-context.sh' }] }] },
    }
    const out = injectManagedHook(config, 'SessionStart', CMD) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }
    expect(out.hooks.SessionStart).toHaveLength(2)
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe('load-context.sh') // untouched
    expect(out.hooks.SessionStart[1].hooks[0].command).toBe(CMD)
  })

  it('never clobbers the matcher of a group sharing unrelated hooks', () => {
    // Our entry sits in a group that also holds an unrelated hook (simulated prior state).
    const shared = {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'echo foreign' },
            { type: 'command', command: CMD }, // our entry sharing a foreign matcher group
          ],
        }],
      },
    }
    const out = injectManagedHook(shared, 'PreToolUse', CMD, '.*') as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }
    // Group matcher stays 'Bash' (not '.*'); only our command updated.
    expect(out.hooks.PreToolUse[0].matcher).toBe('Bash')
  })

  it('installs under a non-SessionStart event key (PreToolUse) with an event-arg command', () => {
    const cmd = generateHookCommand(PS1, 'claude', 'pre_tool_use', 'win32')
    const out = injectManagedHook({}, 'PreToolUse', cmd, '') as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }
    expect(out.hooks.PreToolUse[0].matcher).toBe('')
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe(cmd)
  })
})

describe('removeManagedHook', () => {
  const CMD = generateHookCommand(PS1, 'claude', undefined, 'win32')

  it('removes only our hook and leaves unrelated SessionStart groups intact', () => {
    const installed = injectManagedHook(
      { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'load-context.sh' }] }] } },
      'SessionStart', CMD,
    )
    const out = removeManagedHook(installed) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }
    expect(out.hooks.SessionStart).toHaveLength(1)
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe('load-context.sh')
  })

  it('drops the event key when only our hook was present', () => {
    const installed = injectManagedHook({}, 'SessionStart', CMD)
    const out = removeManagedHook(installed) as { hooks?: Record<string, unknown> }
    expect(out.hooks?.SessionStart).toBeUndefined()
  })

  it('drops the hooks object entirely when no hooks remain', () => {
    const installed = injectManagedHook({}, 'SessionStart', CMD)
    const out = removeManagedHook(installed) as { hooks?: Record<string, unknown> }
    expect(out.hooks).toBeUndefined()
  })

  it('removes our entries across MULTIPLE event keys at once, preserving unrelated events', () => {
    const config = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: CMD }] }],
        PreToolUse: [{
          matcher: '',
          hooks: [
            { type: 'command', command: generateHookCommand(PS1, 'claude', 'pre_tool_use', 'win32') },
            { type: 'command', command: 'echo foreign-tool' },
          ],
        }],
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    }
    const out = removeManagedHook(config) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(out.hooks.SessionStart).toBeUndefined()
    expect(out.hooks.PreToolUse).toHaveLength(1)
    expect(out.hooks.PreToolUse[0].hooks).toHaveLength(1)
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe('echo foreign-tool')
    expect(out.hooks.UserPromptSubmit[0].hooks[0].command).toBe('echo user')
  })
})

describe('pruneManagedHooks', () => {
  const CMD = generateHookCommand(PS1, 'claude', undefined, 'win32')

  it('removes our orphaned entries from keys NOT in the allow-list', () => {
    // Simulates a prior version's install: a managed PostToolUse that the current set dropped.
    const config = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: CMD }] }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: generateHookCommand(PS1, 'claude', 'post_tool_use', 'win32') }] }],
      },
    }
    const out = pruneManagedHooks(config, new Set(['SessionStart'])) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(out.hooks.SessionStart).toBeDefined() // allowed key kept
    expect(out.hooks.PostToolUse).toBeUndefined() // orphaned key dropped
  })

  it('preserves unrelated hooks mixed into an orphaned key', () => {
    const config = {
      hooks: {
        PostToolUse: [{
          matcher: '',
          hooks: [
            { type: 'command', command: generateHookCommand(PS1, 'claude', 'post_tool_use', 'win32') },
            { type: 'command', command: 'echo foreign' },
          ],
        }],
      },
    }
    const out = pruneManagedHooks(config, new Set(['SessionStart'])) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } }
    expect(out.hooks.PostToolUse).toHaveLength(1)
    expect(out.hooks.PostToolUse[0].hooks).toHaveLength(1)
    expect(out.hooks.PostToolUse[0].hooks[0].command).toBe('echo foreign')
  })

  it('leaves allowed keys untouched (inject reconciles those in place)', () => {
    const config = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: CMD }] }],
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo foreign' }] }],
      },
    }
    const out = pruneManagedHooks(config, new Set(['SessionStart', 'PreToolUse'])) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe(CMD)
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe('echo foreign')
  })

  it('with an empty allow-list behaves identically to removeManagedHook', () => {
    const installed = injectManagedHook({}, 'SessionStart', CMD)
    expect(pruneManagedHooks(installed, new Set())).toEqual(removeManagedHook(installed))
  })
})

describe('hasManagedHook', () => {
  const CMD = generateHookCommand(PS1, 'claude', undefined, 'win32')

  it('is false on an empty config', () => {
    expect(hasManagedHook({})).toBe(false)
  })

  it('is true when our hook sits under SessionStart', () => {
    expect(hasManagedHook(injectManagedHook({}, 'SessionStart', CMD))).toBe(true)
  })

  it('is true when our hook sits under a non-SessionStart event key only', () => {
    const cmd = generateHookCommand(PS1, 'claude', 'stop', 'win32')
    expect(hasManagedHook(injectManagedHook({}, 'Stop', cmd, ''))).toBe(true)
  })

  it('is false when only unrelated hooks are present', () => {
    const config = { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo x' }] }] } }
    expect(hasManagedHook(config)).toBe(false)
  })
})