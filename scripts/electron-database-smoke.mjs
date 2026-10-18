import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(projectRoot, 'scripts', 'electron-database-smoke.ts')
const outfile = path.join(projectRoot, 'scripts', `.electron-database-smoke-${process.pid}.cjs`)
const require = createRequire(import.meta.url)
const electronExecutable = require('electron')

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3', 'electron'],
    outfile,
  })
  const result = spawnSync(electronExecutable, ['--no-sandbox', outfile, ...process.argv.slice(2)], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  fs.rmSync(outfile, { force: true })
}
