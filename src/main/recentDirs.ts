import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

const MAX_RECENT = 20

function filePath(): string {
  return path.join(app.getPath('userData'), 'recent-dirs.json')
}

export function getRecentDirs(): string[] {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore — file may not exist yet
  }
  return []
}

export function addRecentDir(dir: string): void {
  const normalized = path.normalize(dir)
  const existing = getRecentDirs()
  const deduped = existing.filter(
    (d) => path.normalize(d).toLowerCase() !== normalized.toLowerCase()
  )
  const updated = [normalized, ...deduped].slice(0, MAX_RECENT)
  try {
    fs.writeFileSync(filePath(), JSON.stringify(updated), 'utf8')
  } catch {
    // ignore write errors (e.g. permissions)
  }
}
