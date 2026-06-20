import { existsSync } from 'fs'
import { join } from 'path'

export function shellIntegrationCommand(): string[] {
  if (process.platform !== 'win32') return []

  const candidates = [
    join(__dirname, 'shellIntegration.ps1'),
    join(__dirname, '..', 'shellIntegration.ps1'),
    join(process.cwd(), 'src', 'main', 'pty', 'shellIntegration.ps1'),
  ]
  const scriptPath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
  return [
    '-NoLogo',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `try { . "${escapePowerShellDoubleQuoted(scriptPath)}" } catch {}`,
  ]
}

function escapePowerShellDoubleQuoted(value: string): string {
  return value.replace(/`/g, '``').replace(/"/g, '`"')
}
