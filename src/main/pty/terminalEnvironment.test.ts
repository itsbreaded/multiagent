import { describe, it, expect } from 'vitest'
import { unixShellLaunch } from './terminalEnvironment'

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