#!/usr/bin/env node
// Generate build/icon.icns from build/icon.png on macOS (uses sips + iconutil, both
// preinstalled). No-op on other platforms — the .icns is only needed for mac packaging,
// and the CI mac runner is the only place it must exist before `electron-builder --mac`.
// electron-builder auto-detects build/icon.icns for the mac target, so the build config
// does not hard-reference it (a missing .icns falls back to the default Electron icon).
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync as exec } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const png = resolve(root, 'build/icon.png')
const iconset = resolve(root, 'build/icon.iconset')
const out = resolve(root, 'build/icon.icns')

if (process.platform !== 'darwin') {
  console.log('[build:icon] skipped (not macOS)')
  process.exit(0)
}
if (!existsSync(png)) {
  console.error('[build:icon] build/icon.png missing — cannot generate icon.icns')
  process.exit(1)
}

rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })

// Standard .iconset layout (10 files). sips resizes the source 512px png up/down as needed.
const entries = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
]
for (const [size, name] of entries) {
  exec('sips', ['-z', String(size), String(size), png, '--out', resolve(iconset, name)], { stdio: 'inherit' })
}

exec('iconutil', ['-c', 'icns', iconset, '--output', out], { stdio: 'inherit' })
console.log(`[build:icon] generated ${out}`)