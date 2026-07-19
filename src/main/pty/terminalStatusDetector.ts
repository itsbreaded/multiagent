/**
 * terminalStatusDetector -- pure fatal-terminal-error detector (spec 050).
 *
 * The complementary scraping source for the status badge. The hook system (spec 032)
 * is authoritative wherever it can report, but it has honest gaps -- notably Codex
 * has no StopFailure hook and no error hook, so a fatal API error prints to the
 * terminal and the badge stays stuck on `working`. This detector is the scoped,
 * opt-in exception: it watches the PTY byte stream for a small set of canonical,
 * high-specificity fatal-output signatures and emits a single `terminal_error`
 * event that feeds the SAME `eventToState` reducer as hook events.
 *
 * Purity discipline matches agentStatus.ts / paneTree.ts / agentProcessSweeper.ts:
 * no Electron deps, no IO, no Date.now()/Math.random(), fully deterministic. The
 * caller owns the byte stream and the `now` timestamp; this module only pattern-
 * matches. That keeps the whole surface unit-testable with synthetic input.
 *
 * The 048 lesson (do not repeat it): the previous scraping attempt matched loose
 * single-phrase substrings ("do you want to proceed?") over a large scrollback
 * window and misread ordinary chat that *discussed* the detection rules as a live
 * prompt. This module avoids that failure by construction:
 *   1. Canonical signatures only -- never keywords like `Error:`/`panic`/`fatal`.
 *   2. Rolling fresh-output buffer -- never the pane's scrollback history. A match
 *      is only reported when its END falls inside the freshly-arrived bytes, so an
 *      old line still in the rolling buffer is never re-emitted on later feeds.
 *   3. Per-agentKind gating (the pipeline is agent-agnostic; Codex is the first
 *      entry, not a special case). Future agents are additive: add a row to the
 *      pattern table, touch nothing else.
 */

import type { AgentKind } from '../../shared/types'

/**
 * Strip ANSI/VT escape sequences so signature matching sees the VISIBLE text, not the
 * color/control codes a TUI interleaves. Real agents (Codex prints fatal errors in red)
 * emit SGR color escapes -- sometimes INSIDE a signature span (e.g.
 * `unexpected status \x1b[31m404\x1b[0m Not Found`), which would break a literal regex.
 * Stripping here keeps the rolling buffer plain text and the patterns honest. CSI covers
 * SGR (`\x1b[...m`), cursor moves, erase, etc.; the bare-Esc forms cover the rest.
 */
const ANSI_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|\x1b[)(][A-Z0-9]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPES, '')
}

/** The single event this v1 detector can emit. Room is left for a future family. */
export type TerminalStatusEvent =
  | { event: 'terminal_error'; detail: string }

/**
 * One detection rule. `event` is currently always `'terminal_error'`; the field is
 * kept so a future non-fatal `terminal_*` family can reuse the same plumbing
 * without changing the type of the registry.
 */
export interface PatternEntry {
  event: 'terminal_error'
  /** High-specificity regex. Never use `g`/`y` -- exec must be stateless. */
  regex: RegExp
  /** Builds the badge tooltip detail from the match. Pure. */
  detail: (match: RegExpMatchArray | RegExpExecArray) => string
}

/**
 * The per-agentKind pattern table. This is the whole extensibility surface: add
 * a row to plug in a new agent's fatal signatures, touch nothing in the pipeline.
 * `claude` is empty today (hooks cover Claude's error path via StopFailure).
 */
export const TERMINAL_STATUS_PATTERNS: Record<AgentKind, PatternEntry[]> = {
  claude: [],
  codex: [
    {
      // Codex's fatal provider-compat line, e.g.:
      //   `unexpected status 404 Not Found: Unknown error, url: https://api.z.ai/...`
      // The `, url:` tail is required for specificity -- it distinguishes a real
      // provider response from any prose that happens to contain "unexpected status".
      event: 'terminal_error',
      regex: /unexpected status \d{3}\b[^\n]*?, url:/,
      detail: (m) => {
        const code = /\b(\d{3})\b/.exec(m[0])?.[1]
        return code ? `terminal error (HTTP ${code})` : 'terminal error'
      },
    },
    {
      // Codex's fatal retry-exhaustion line, e.g.:
      //   `API failed after 3 retries — upstream returned 5xx`
      event: 'terminal_error',
      regex: /API failed after \d+ retries/,
      detail: (m) => {
        const n = /after (\d+) retries/.exec(m[0])?.[1]
        return n ? `API failed after ${n} retries` : 'API failed (retries exhausted)'
      },
    },
  ],
}

export interface DetectorOptions {
  /** Maximum rolling-buffer size in bytes (default 2048). */
  maxBufferBytes?: number
  /**
   * Backscan overlap applied on each feed so a signature split across two PTY
   * writes still matches. Defaults to 256 -- comfortably wider than any pattern.
   */
  overlap?: number
}

/**
 * Per-pane detector. Holds a small rolling fresh-output buffer (line-aligned when
 * trimmed) and reports a match only when its END falls inside the freshly-arrived
 * bytes. That single rule gives both guarantees we need:
 *   - a signature split across chunks fires exactly once (its end crosses into
 *     the new region only on the chunk that completes it), and
 *   - an old line still in the rolling buffer never re-fires on later feeds
 *     (its end is behind `prevLen`).
 *
 * The reducer's latch is the dedup of record at the badge level -- the detector
 * is not the dedup authority, it just avoids obviously-wasteful re-emissions.
 */
export class Detector {
  private buffer = ''
  private readonly maxBuffer: number
  private readonly overlap: number

  constructor(
    private readonly patterns: PatternEntry[],
    options: DetectorOptions = {},
  ) {
    this.maxBuffer = options.maxBufferBytes ?? 2048
    this.overlap = options.overlap ?? 256
  }

  /**
   * Feed fresh PTY bytes. Returns the first match whose END falls inside the new
   * region, or null. Pure with respect to the outside world (no IO, no clock) but
   * stateful in its own rolling buffer -- call `reset()` between unrelated streams.
   */
  feed(bytes: string): TerminalStatusEvent | null {
    if (!bytes) return null
    // Strip ANSI before buffering so the rolling window and the match-end region math
    // both operate on visible text. Color codes inside a signature span would otherwise
    // defeat the regex even when the human-visible line is an exact match.
    bytes = stripAnsi(bytes)
    // Trim the PRE-existing buffer down to the cap BEFORE appending so `prevLen`
    // is a stable index for the new-region test. Trimming first is what makes the
    // match-end > prevLen rule correct regardless of buffer age.
    this.trimInner()
    const prevLen = this.buffer.length
    this.buffer += bytes

    const scanStart = Math.max(0, prevLen - this.overlap)
    const window = this.buffer.slice(scanStart)
    for (const entry of this.patterns) {
      // The regex has no `g` flag, so exec is stateless. Walk past any older hits
      // the backscan picked up so we can still reach a match that completes inside
      // the new region.
      let rest = window
      let offsetInWindow = 0
      while (rest) {
        const m = entry.regex.exec(rest)
        if (!m) break
        const advance = m.index + m[0].length
        const absEnd = scanStart + offsetInWindow + advance
        if (absEnd > prevLen) {
          return { event: entry.event, detail: entry.detail(m) }
        }
        // Older hit (end behind prevLen) -- skip and keep looking in this same feed.
        offsetInWindow += advance
        rest = rest.slice(advance)
      }
    }
    return null
  }

  /** Clear all buffer state. Called when the detector is detached from a pane. */
  reset(): void {
    this.buffer = ''
  }

  /** Drop the oldest bytes, snapping forward to the next newline so the buffer
   *  stays line-aligned (a signature never starts mid-line after a trim). */
  private trimInner(): void {
    if (this.buffer.length <= this.maxBuffer) return
    const cut = this.buffer.length - this.maxBuffer
    const newline = this.buffer.indexOf('\n', cut)
    // If there is no newline in the trailing window we are mid-line on a very long
    // write; drop everything before `cut` rather than hold a pathological buffer.
    const snap = newline === -1 ? cut : newline + 1
    this.buffer = this.buffer.slice(snap)
  }
}

/** Factory: build a Detector for the given agentKind from the shared pattern table. */
export function createDetector(agentKind: AgentKind, options?: DetectorOptions): Detector {
  return new Detector(TERMINAL_STATUS_PATTERNS[agentKind], options)
}
