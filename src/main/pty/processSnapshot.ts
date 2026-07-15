/**
 * processSnapshot — the single platform-specific seam for reading the process tree.
 *
 * Returns a flat `ProcessEntry[]` (`pid`, `parentPid`, `name`, `argv`) that the pure
 * selector in `agentProcessDetect.ts` consumes. Everything above this function — the
 * selector, the sweeper, IPC, the renderer store — is platform-agnostic, so each platform's
 * implementation slots in behind this same interface with no other changes. See spec 047
 * phase 1b.
 *
 * Platform implementations:
 *  - win32  — shells out to `Get-CimInstance Win32_Process` (no native dependency / no
 *             Visual Studio Build Tools requirement, unlike @vscode/windows-process-tree).
 *  - darwin — shells out to `ps -Ax -o pid=,ppid=,comm=,command=` (preinstalled, no native
 *             build). One process per sweep; the sweeper only ticks when shell panes exist.
 *  - linux  — reads `/proc/<pid>/{stat,cmdline}` directly (no shell-out, null-delimited argv
 *             so wrapper detection is exact). Per-process sync reads; snapshot sizes are
 *             modest and the poll is a 2.5 s advisory sweep, so this is acceptable.
 *
 * Fails closed on every platform: any error → empty snapshot (→ no candidate → pane stays a
 * shell). A flaky sweep must never mis-promote or demote.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdirSync, readFileSync } from 'fs'
import { basename } from 'path'
import { splitCommandLine, type ProcessEntry } from './agentProcessDetect'

const execFileAsync = promisify(execFile)

// One-shot CSV-ish dump: convertTo-Json is robust against commas/quotes in CommandLine
// (ConvertTo-Csv is more parser-fragile across PS versions). Select only the columns we
// need to keep the payload small.
const CIM_COMMAND =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2'

let warnedUnsupported = false

interface CimRecord {
  ProcessId: number | null
  ParentProcessId: number | null
  Name: string | null
  CommandLine: string | null
}

/** Parse CIM JSON records into the flat ProcessEntry[] the selector consumes. Exported
 *  for unit testing the JSON→entry mapping without spawning PowerShell. */
export function toEntries(records: CimRecord[]): ProcessEntry[] {
  const out: ProcessEntry[] = []
  for (const r of records) {
    if (typeof r.ProcessId !== 'number' || typeof r.ParentProcessId !== 'number') continue
    const cmdline = r.CommandLine ?? r.Name ?? ''
    // The program name from CIM is the executable image name (e.g. "claude.exe"). argv is
    // the parsed command line; if it's empty, fall back to a single-element argv so the
    // name-based direct match still works.
    const argv = cmdline.trim() ? splitCommandLine(cmdline) : [r.Name ?? '']
    out.push({
      pid: r.ProcessId,
      parentPid: r.ParentProcessId,
      name: r.Name ?? argv[0] ?? '',
      argv,
    })
  }
  return out
}

/**
 * Parse `ps -Ax -o pid=,ppid=,comm=,command=` output into `ProcessEntry[]`. Exported for
 * unit testing the line→entry mapping without spawning `ps`. `comm` is the executable
 * basename (no spaces); `command` is the full command line (may contain spaces, so it is
 * the trailing field). argv is the existing quote-aware `splitCommandLine` of `command`.
 */
export function parsePsDarwin(stdout: string): ProcessEntry[] {
  const out: ProcessEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    // pid (digits) | ppid (digits) | comm (no spaces) | optional command (rest, may be empty)
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?\s*$/)
    if (!m) continue
    const pid = Number(m[1])
    const parentPid = Number(m[2])
    const comm = m[3]
    const command = m[4] ?? ''
    const argv = command.trim() ? splitCommandLine(command) : [comm]
    out.push({ pid, parentPid, name: comm, argv })
  }
  return out
}

/**
 * Parse a `/proc/<pid>/stat` line into `{ pid, comm, ppid }`. The `comm` field is wrapped in
 * parens and may itself contain spaces or parens, so we parse by the FIRST `(` and the LAST
 * `)`, not by whitespace. Exported for unit testing without touching `/proc`.
 *
 * Format: `<pid> (<comm>) <state> <ppid> <pgrp> ...`
 */
export function parseProcStat(stat: string): { pid: number; comm: string; ppid: number } | null {
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (open < 0 || close <= open) return null
  const pid = Number(stat.slice(0, open).trim())
  const comm = stat.slice(open + 1, close)
  // After the closing paren: <state> <ppid> <pgrp> ... — ppid is the 2nd token.
  const rest = stat.slice(close + 1).trim().split(/\s+/)
  const ppid = Number(rest[1])
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null
  return { pid, comm, ppid }
}

/**
 * Parse a `/proc/<pid>/cmdline` buffer (null-delimited argv) into an argv array. Exported
 * for unit testing without touching `/proc`. Empty buffer → `[]` (kernel thread / no
 * command line).
 */
export function parseProcCmdline(buf: Buffer): string[] {
  if (buf.length === 0) return []
  const out: string[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      // A trailing run of NULs produces empty trailing tokens; drop them.
      const slice = buf.slice(start, i)
      if (slice.length > 0) out.push(slice.toString('utf8'))
      start = i + 1
    }
  }
  if (start < buf.length) out.push(buf.slice(start).toString('utf8'))
  return out
}

/**
 * Snapshot the whole process table once. The caller (sweeper) does its own per-pane
 * descendant selection on the returned flat list — we do NOT snapshot per pane.
 */
export async function snapshotProcesses(): Promise<ProcessEntry[]> {
  const platform = process.platform
  try {
    if (platform === 'win32') return await snapshotWindows()
    if (platform === 'darwin') return await snapshotDarwin()
    if (platform === 'linux') return snapshotLinux()
  } catch (err) {
    // Fail closed: any error → no candidates → panes stay shells.
    console.warn('[MultiAgent] process snapshot failed (staying closed):', err)
    return []
  }

  if (!warnedUnsupported) {
    warnedUnsupported = true
    console.warn(
      `[MultiAgent] agent process detection is not implemented on ${platform}; panes will not be promoted on this platform`,
    )
  }
  return []
}

async function snapshotWindows(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', CIM_COMMAND],
    { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  )
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as CimRecord | CimRecord[]
  const records = Array.isArray(parsed) ? parsed : [parsed]
  return toEntries(records)
}

async function snapshotDarwin(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync('ps', ['-Ax', '-o', 'pid=,ppid=,comm=,command='], {
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return parsePsDarwin(stdout)
}

function snapshotLinux(): ProcessEntry[] {
  const out: ProcessEntry[] = []
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return []
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8')
    } catch {
      continue
    }
    const parsed = parseProcStat(stat)
    if (!parsed) continue
    let argv: string[]
    try {
      argv = parseProcCmdline(readFileSync(`/proc/${name}/cmdline`))
    } catch {
      argv = []
    }
    // Skip kernel threads / processes with no command line — they cannot be an agent, and
    // including a comm-only entry would mislead the selector's direct-name match.
    if (argv.length === 0) continue
    out.push({
      pid: parsed.pid,
      parentPid: parsed.ppid,
      name: basename(argv[0]),
      argv,
    })
  }
  return out
}