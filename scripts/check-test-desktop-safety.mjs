import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceExtensions = new Set(['.cjs', '.html', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const filesToCheck = []
const e2eFilesToCheck = []

async function collect(directory, includeFile) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await collect(fullPath, includeFile)
      continue
    }
    if (entry.isFile() && includeFile(fullPath)) filesToCheck.push(fullPath)
  }
}

const sourceTestPattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/i
await collect(path.join(projectRoot, 'src'), (file) => sourceTestPattern.test(file))
await collect(path.join(projectRoot, 'tests'), (file) => sourceExtensions.has(path.extname(file).toLowerCase()))
await collect(path.join(projectRoot, 'e2e'), (file) => {
  if (!sourceExtensions.has(path.extname(file).toLowerCase())) return false
  e2eFilesToCheck.push(file)
  return true
})
for (const name of ['electron-database-smoke.mjs', 'electron-database-smoke.ts']) {
  const file = path.join(projectRoot, 'scripts', name)
  try {
    await readFile(file)
    filesToCheck.push(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const nativeDialogCalls = /\b(?:window|globalThis)\s*\.\s*(?:alert|confirm|prompt)\s*\(/g
const nativeSelectPopupTrigger = /Alt\s*\+\s*ArrowDown/i
const browserWindowConstructor = /\bnew\s+BrowserWindow\s*\(([\s\S]*?)\)/g
const forbiddenNativeUiCalls = /\b(?:dialog\s*\.\s*(?:showOpenDialog|showOpenDialogSync|showSaveDialog|showSaveDialogSync|showMessageBox|showMessageBoxSync|showErrorBox)|(?:Menu|menu)\s*\.\s*popup)\s*\(/g
const forbiddenExternalLaunchCalls = /\b(?:shell|electron\s*\.\s*shell)\s*\.\s*(?:openExternal|openPath|showItemInFolder)\s*\(/g
const directNetworkCalls = /\b(?:fetch|goto|loadURL|navigate)\s*\(\s*(['"`])(https?:\/\/[^'"`]+)\1/g
const violations = []
for (const file of filesToCheck) {
  const source = await readFile(file, 'utf8')
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (nativeDialogCalls.test(lines[index])) {
      violations.push(`${path.relative(projectRoot, file)}:${index + 1}`)
    }
    nativeDialogCalls.lastIndex = 0
    if (nativeSelectPopupTrigger.test(lines[index])) {
      violations.push(`${path.relative(projectRoot, file)}:${index + 1} (native select popup trigger)`)
    }
  }

  for (const [pattern, description] of [
    [forbiddenNativeUiCalls, 'native dialog/menu activation'],
    [forbiddenExternalLaunchCalls, 'external application launch'],
  ]) {
    let match
    while ((match = pattern.exec(source))) {
      const line = source.slice(0, match.index).split(/\r?\n/).length
      violations.push(`${path.relative(projectRoot, file)}:${line} (${description})`)
    }
    pattern.lastIndex = 0
  }
}

for (const file of filesToCheck) {
  const source = await readFile(file, 'utf8')
  let match
  while ((match = browserWindowConstructor.exec(source))) {
    const webPreferences = /\bwebPreferences\s*:\s*\{[^}]*\}/.exec(match[1])?.[0] ?? ''
    if (!/\bshow\s*:\s*false\b/.test(match[1]) || !/\boffscreen\s*:\s*true\b/.test(webPreferences)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length
      violations.push(`${path.relative(projectRoot, file)}:${line} (BrowserWindow must be hidden and offscreen)`)
    }
  }
  browserWindowConstructor.lastIndex = 0
}

for (const file of e2eFilesToCheck) {
  const source = await readFile(file, 'utf8')
  let networkCall
  while ((networkCall = directNetworkCalls.exec(source))) {
    const url = networkCall[2]
    const hostname = /^https?:\/\/(?:\[([^\]]+)\]|([^/:?#]+))/i.exec(url)?.slice(1).find(Boolean)?.toLowerCase()
    if (!hostname || (hostname !== 'localhost' && hostname !== '::1' && !/^127(?:\.\d{1,3}){3}$/.test(hostname))) {
      const line = source.slice(0, networkCall.index).split(/\r?\n/).length
      violations.push(`${path.relative(projectRoot, file)}:${line} (direct non-loopback E2E network target)`)
    }
  }
  directNetworkCalls.lastIndex = 0

  if (!source.includes('electron.launch(')) continue
  for (const required of ['MULTIAGENT_ALLOW_MULTI_INSTANCE', 'MULTIAGENT_E2E_USER_DATA_DIR', 'assertDesktopIsolation']) {
    if (!source.includes(required)) {
      violations.push(`${path.relative(projectRoot, file)} (Electron E2E launch must retain ${required})`)
    }
  }
}

if (violations.length > 0) {
  console.error('Test desktop-safety check failed: unsafe UI, window, external-launch, or network configuration found.')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Test desktop-safety check passed (${filesToCheck.length} test/fixture files scanned).`)
}
