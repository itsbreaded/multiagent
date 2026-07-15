import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { unixShellLaunch, shellIntegrationCommand } from './terminalEnvironment'

const originalPlatform = process.platform
function pinPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value })
}
function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
}

// Unix shell-integration wiring: bash gets `--init-file`, zsh gets a `ZDOTDIR` env, unknown
// shells and script-missing fall back to the bare shell. `unixShellLaunch` takes injectable
// deps so we never touch Electron's `app` / the filesystem in unit tests (the real
// materialization lives in ensureShellIntegrationScript / ensureZshZdotdir).

const script = '/userdata/shellIntegration.sh'
const zdotdir = '/userdata/shell-integration-zsh'

const okDeps = {
  ensureScript: () => script,
  ensureZdotdir: () => zdotdir,
}
const noScriptDeps = {
  ensureScript: () => null,
  ensureZdotdir: () => zdotdir,
}
const noZdotdirDeps = {
  ensureScript: () => script,
  ensureZdotdir: () => null,
}

describe('unixShellLaunch', () => {
  it('launches bash with --init-file pointing at the materialized script', () => {
    expect(unixShellLaunch('bash', okDeps)).toEqual({
      cmd: ['bash', '--init-file', script],
    })
  })

  it('resolves the bash basename from a full path', () => {
    expect(unixShellLaunch('/usr/local/bin/bash', okDeps)).toEqual({
      cmd: ['/usr/local/bin/bash', '--init-file', script],
    })
  })

  it('launches zsh with a ZDOTDIR env (zsh has no --init-file)', () => {
    expect(unixShellLaunch('zsh', okDeps)).toEqual({
      cmd: ['zsh'],
      env: { ZDOTDIR: zdotdir },
    })
  })

  it('resolves the zsh basename from a full path (macOS default shell)', () => {
    expect(unixShellLaunch('/bin/zsh', okDeps)).toEqual({
      cmd: ['/bin/zsh'],
      env: { ZDOTDIR: zdotdir },
    })
  })

  it('falls back to the bare shell when the script cannot be materialized', () => {
    expect(unixShellLaunch('bash', noScriptDeps)).toEqual({ cmd: ['bash'] })
    expect(unixShellLaunch('zsh', noScriptDeps)).toEqual({ cmd: ['zsh'] })
  })

  it('falls back to the bare zsh when the zdotdir cannot be materialized', () => {
    expect(unixShellLaunch('zsh', noZdotdirDeps)).toEqual({ cmd: ['zsh'] })
  })

  it('launches unknown shells (sh/fish) without integration', () => {
    expect(unixShellLaunch('sh', okDeps)).toEqual({ cmd: ['sh'] })
    expect(unixShellLaunch('fish', okDeps)).toEqual({ cmd: ['fish'] })
  })
})

// Windows shell integration sources shellIntegration.ps1. The bundled asset lives inside
// app.asar when packaged — PowerShell can't read it — so the command must prefer a real
// <userData> copy (ensureScript) and only fall back to the bundled/asar path. The args are
// otherwise unchanged. platform is pinned; deps are injected so no Electron/fs is touched.
describe('shellIntegrationCommand (Windows)', () => {
  beforeEach(() => pinPlatform('win32'))
  afterEach(() => restorePlatform())

  it('returns [] off win32', () => {
    pinPlatform('linux')
    expect(shellIntegrationCommand({ ensureScript: () => null, bundled: () => null })).toEqual([])
  })

  it('prefers the materialized <userData> copy over the bundled asset', () => {
    const args = shellIntegrationCommand({
      ensureScript: () => 'C:/userData/shellIntegration.ps1',
      bundled: () => 'C:/app.asar/shellIntegration.ps1',
    })
    expect(args).toEqual([
      '-NoLogo',
      '-NoExit',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'try { . "C:/userData/shellIntegration.ps1" } catch {}',
    ])
  })

  it('falls back to the bundled asset path when the materialized copy is unavailable (dev)', () => {
    const args = shellIntegrationCommand({
      ensureScript: () => null,
      bundled: () => 'C:/repo/src/main/pty/shellIntegration.ps1',
    })
    expect(args[args.length - 1]).toBe(
      'try { . "C:/repo/src/main/pty/shellIntegration.ps1" } catch {}',
    )
  })

  it('escapes backticks and double quotes in the sourced path', () => {
    const args = shellIntegrationCommand({
      ensureScript: () => 'C:/a`b"c\\dir.ps1',
      bundled: () => null,
    })
    // ` -> `` and " -> `" inside the double-quoted PowerShell string.
    expect(args[args.length - 1]).toBe('try { . "C:/a``b`"c\\dir.ps1" } catch {}')
  })
})