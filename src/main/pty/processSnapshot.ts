/**
 * processSnapshot — the single platform-specific seam for reading the process tree.
 *
 * Returns a flat `ProcessEntry[]` (`pid`, `parentPid`, `name`, `argv`) that the pure
 * selector in `agentProcessDetect.ts` consumes. Everything above this function — the
 * selector, the sweeper, IPC, the renderer store — is platform-agnostic, so a future
 * Linux (`/proc/<pid>/{stat,cmdline}`) or macOS (`ps -o pid,ppid,command`) implementation
 * slots in behind this same interface with no other changes. See spec 047 phase 1b.
 *
 * Windows implementation shells out to `Get-CimInstance Win32_Process` (no native
 * dependency / no Visual Studio Build Tools requirement, unlike @vscode/windows-process-
 * tree which builds from source on every install). Spawns one PowerShell process per
 * sweep (~100–300 ms); the sweeper only ticks when shell panes exist and snapshots once
 * per tick shared across all panes, so this is acceptable for a 2–3 s advisory poll.
 *
 * Fails closed: any error → empty snapshot (→ no candidate → pane stays a shell). Never
 * surfaces a process the user does not own; Get-CimInstance only enumerates the current
 * session's accessible processes and a per-user installer runs at user privilege.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { splitCommandLine, type ProcessEntry } from './agentProcessDetect'

const execFileAsync = promisify(execFile)

// One-shot CSV-ish dump: convertTo-Json is robust against commas/quotes in CommandLine
// (ConvertTo-Csv is more parser-fragile across PS versions). Select only the columns we
// need to keep the payload small.
const CIM_COMMAND =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2'

let warnedNonWindows = false

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
 * Snapshot the whole process table once. The caller (sweeper) does its own per-pane
 * descendant selection on the returned flat list — we do NOT snapshot per pane.
 */
export async function snapshotProcesses(): Promise<ProcessEntry[]> {
  if (process.platform !== 'win32') {
    if (!warnedNonWindows) {
      warnedNonWindows = true
      // CLI-launched-agent detection is a Windows feature for now (spec 047). Linux/Mac
      // would implement this interface against /proc or ps; until then, fail closed.
      console.warn('[MultiAgent] agent process detection is Windows-only; panes will not be promoted on this platform')
    }
    return []
  }
  try {
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
  } catch (err) {
    // Fail closed: any PowerShell/parse error → no candidates → panes stay shells.
    // A flaky sweep must never mis-promote or demote.
    console.warn('[MultiAgent] process snapshot failed (staying closed):', err)
    return []
  }
}