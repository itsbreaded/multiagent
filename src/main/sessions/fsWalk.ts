import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'

export async function walkJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries: fs.Dirent[]
  try { entries = await fsPromises.readdir(dir, { withFileTypes: true }) } catch { return results }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...await walkJsonlFiles(entryPath))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(entryPath)
  }
  return results
}
