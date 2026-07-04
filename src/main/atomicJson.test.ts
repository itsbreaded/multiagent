import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeJsonAtomic } from './atomicJson'

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-'))
}

afterEach(() => {
  // Vitest isolates temp dirs per test; mkdtempSync results are GC'd by the OS
  // on reboot, but we leave cleanup to the test bodies for clarity.
})

describe('writeJsonAtomic', () => {
  it('round-trips an object', () => {
    const dir = makeDir()
    const target = path.join(dir, 'out.json')
    const obj = { a: 1, nested: { b: [1, 2, 3] } }
    writeJsonAtomic(target, obj)
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(obj)
  })

  it('overwrites an existing file (rename over target)', () => {
    const dir = makeDir()
    const target = path.join(dir, 'out.json')
    writeJsonAtomic(target, { v: 1 })
    writeJsonAtomic(target, { v: 2 })
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ v: 2 })
  })

  it('leaves no .tmp.* siblings after a successful write', () => {
    const dir = makeDir()
    const target = path.join(dir, 'out.json')
    writeJsonAtomic(target, { v: 1 })
    const siblings = fs.readdirSync(dir)
    expect(siblings).toEqual(['out.json'])
  })

  it('omitting space produces compact output', () => {
    const dir = makeDir()
    const target = path.join(dir, 'out.json')
    writeJsonAtomic(target, { a: 1, b: 2 })
    expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify({ a: 1, b: 2 }))
  })

  it('space param pretty-prints', () => {
    const dir = makeDir()
    const target = path.join(dir, 'out.json')
    const obj = { a: 1, b: 2 }
    writeJsonAtomic(target, obj, 2)
    expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify(obj, null, 2))
  })

  it('cleans up the temp file and leaves the target intact on a serialization failure', () => {
    const dir = makeDir()
    const target = path.join(dir, 'out.json')
    // Seed the target with old, valid content.
    fs.writeFileSync(target, JSON.stringify({ old: true }))

    // BigInt is not JSON-serializable — stringify throws after we may have
    // created the temp file.
    const bad = { a: 1n }
    expect(() => writeJsonAtomic(target, bad)).toThrow()

    // Target untouched (old content survives), no temp litter.
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ old: true })
    expect(fs.readdirSync(dir)).toEqual(['out.json'])
  })
})
