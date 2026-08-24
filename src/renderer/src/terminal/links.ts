import type {
  IBufferLine,
  IDisposable,
  IFunctionIdentifier,
  ILink,
  ILinkProvider,
  Terminal,
} from '@xterm/xterm'

// Keep this in sync with the strict URL matcher used by xterm's web-links
// addon. Automatic detection is intentionally HTTP(S)-only; OSC-8 links use
// the separate xterm linkHandler path and retain their existing policy.
export const TERMINAL_URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/

const MAX_LINK_LENGTH = 2048
const MAX_TRACKED_ROWS = 4096

interface ContinuityKey {
  bufferType: 'normal' | 'alternate'
  row: number
}

export interface LinkContinuityTracker {
  markRowStart(key: ContinuityKey): void
  hasRowStart(key: ContinuityKey): boolean
  clear(): void
}

export function createLinkContinuityTracker(): LinkContinuityTracker {
  const rows = new Map<string, true>()
  const keyOf = ({ bufferType, row }: ContinuityKey): string => `${bufferType}:${row}`

  return {
    markRowStart(key) {
      const id = keyOf(key)
      rows.delete(id)
      rows.set(id, true)
      while (rows.size > MAX_TRACKED_ROWS) {
        const oldest = rows.keys().next().value
        if (oldest === undefined) break
        rows.delete(oldest)
      }
    },
    hasRowStart(key) {
      return rows.has(keyOf(key))
    },
    clear() {
      rows.clear()
    },
  }
}

export function isPrimaryLinkActivation(event: MouseEvent): boolean {
  return event.button === 0
}

export function createPrimaryLinkActivator(activate: TerminalLinkActivator): TerminalLinkActivator {
  return (event, uri) => {
    if (isPrimaryLinkActivation(event)) activate(event, uri)
  }
}

interface LinkChar {
  char: string
  row: number
  column: number
}

interface LineSnapshot {
  row: number
  chars: LinkChar[]
  text: string
  isWrapped: boolean
  startsAtColumnOne: boolean
  reachesRightEdge: boolean
  rowStartObserved: boolean
}

interface LinkTerminalLike {
  cols: number
  buffer: {
    active: {
      type: 'normal' | 'alternate'
      viewportY: number
      getLine(row: number): IBufferLine | undefined
    }
  }
}

export type TerminalLinkActivator = (event: MouseEvent, uri: string) => void

function numberParam(value: number | number[] | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const number = Array.isArray(value) ? value[0] : value
  return number || fallback
}

function isWhitespace(value: string): boolean {
  return /^\s+$/u.test(value)
}

// Without an explicit URL punctuation cue at the row boundary, a cursor-
// positioned continuation is indistinguishable from unrelated text appended
// after a complete URL. Treat that boundary as ambiguous and fail closed.
function hasUrlContinuationCue(previous: LineSnapshot, current: LineSnapshot): boolean {
  const previousChar = previous.text.at(-1) ?? ''
  const currentChar = current.text.at(0) ?? ''
  return /[/?#&=:%+._~-]/u.test(previousChar) || /[/?#&=:%+._~-]/u.test(currentChar)
}

function snapshotLine(
  terminal: LinkTerminalLike,
  tracker: LinkContinuityTracker,
  row: number,
): LineSnapshot | undefined {
  const active = terminal.buffer.active
  const line = active.getLine(row)
  if (!line) return undefined

  const chars: LinkChar[] = []
  let startsAtColumnOne = false
  let reachesRightEdge = false
  let lastMeaningfulIndex = -1

  for (let column = 0; column < terminal.cols; column++) {
    const cell = line.getCell(column)
    if (!cell || cell.getWidth() === 0) continue

    const cellChars = cell.getChars()
    const value = cellChars || ' '
    if (column === 0) startsAtColumnOne = cellChars.length > 0 && !/^\s/u.test(cellChars)
    if (column === terminal.cols - 1) reachesRightEdge = cellChars.length > 0 && !isWhitespace(cellChars)

    for (let offset = 0; offset < value.length; offset++) {
      chars.push({ char: value[offset], row, column })
      if (!isWhitespace(value[offset])) lastMeaningfulIndex = chars.length - 1
    }
  }

  const trimmedChars = lastMeaningfulIndex >= 0 ? chars.slice(0, lastMeaningfulIndex + 1) : []
  return {
    row,
    chars: trimmedChars,
    text: trimmedChars.map((entry) => entry.char).join(''),
    isWrapped: line.isWrapped,
    startsAtColumnOne,
    reachesRightEdge,
    rowStartObserved: tracker.hasRowStart({ bufferType: active.type, row }),
  }
}

function canJoinRows(previous: LineSnapshot, current: LineSnapshot): boolean {
  if (current.isWrapped) return true
  return current.rowStartObserved
    && current.startsAtColumnOne
    && previous.reachesRightEdge
    && hasUrlContinuationCue(previous, current)
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const base = parsed.username && parsed.password
      ? `${parsed.protocol}//${parsed.username}:${parsed.password}@${parsed.host}`
      : parsed.username
        ? `${parsed.protocol}//${parsed.username}@${parsed.host}`
        : `${parsed.protocol}//${parsed.host}`
    return value.toLocaleLowerCase().startsWith(base.toLocaleLowerCase())
  } catch {
    return false
  }
}

function endPosition(
  chars: LinkChar[],
  matchEnd: number,
  columns: number,
): { x: number; y: number } {
  const next = chars[matchEnd]
  if (next) return { x: next.column, y: next.row + 1 }

  const last = chars[matchEnd - 1]
  if (!last) return { x: 0, y: 1 }
  if (last.column + 1 < columns) return { x: last.column + 1, y: last.row + 1 }
  return { x: 0, y: last.row + 2 }
}

function linksInRun(
  rows: LineSnapshot[],
  chars: LinkChar[],
  columns: number,
  activate: TerminalLinkActivator,
): ILink[] {
  const text = chars.map((entry) => entry.char).join('').slice(0, MAX_LINK_LENGTH)
  const regex = new RegExp(TERMINAL_URL_REGEX.source, `${TERMINAL_URL_REGEX.flags}g`)
  const result: ILink[] = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(text))) {
    const uri = match[0]
    if (!isValidUrl(uri)) continue
    const start = chars[match.index]
    const end = chars[match.index + uri.length - 1]
    if (!start || !end) continue
    const lastRow = rows[rows.length - 1]
    const matchEndsAtRunBoundary = match.index + uri.length >= text.length
      && end.row === lastRow?.row
      && end.column === columns - 1
      && lastRow.reachesRightEdge
    const matchHitsScanLimit = match.index + uri.length >= text.length && text.length >= MAX_LINK_LENGTH
    // A URL ending at the terminal edge may be a truncated fragment. Fail
    // closed until a following display-contiguous row makes the target whole.
    if (matchEndsAtRunBoundary || matchHitsScanLimit) continue
    const rangeEnd = endPosition(chars, match.index + uri.length, columns)
    result.push({
      text: uri,
      range: {
        start: { x: start.column + 1, y: start.row + 1 },
        end: rangeEnd,
      },
      activate: (event, value) => {
        if (isPrimaryLinkActivation(event)) activate(event, value)
      },
    })
  }
  return result
}

function buildRun(
  terminal: LinkTerminalLike,
  tracker: LinkContinuityTracker,
  targetRow: number,
): LineSnapshot[] {
  const cache = new Map<number, LineSnapshot | undefined>()
  const get = (row: number): LineSnapshot | undefined => {
    if (!cache.has(row)) cache.set(row, snapshotLine(terminal, tracker, row))
    return cache.get(row)
  }

  const target = get(targetRow)
  if (!target) return []
  let start = targetRow
  let length = target.text.length

  while (start > 0 && length < MAX_LINK_LENGTH) {
    const previous = get(start - 1)
    const current = get(start)
    if (!previous || !current || !canJoinRows(previous, current)) break
    start--
    length += previous.text.length
  }

  let end = targetRow
  while (length < MAX_LINK_LENGTH) {
    const previous = get(end)
    const current = get(end + 1)
    if (!previous || !current || !canJoinRows(previous, current)) break
    end++
    length += current.text.length
  }

  const run: LineSnapshot[] = []
  for (let row = start; row <= end; row++) {
    const snapshot = get(row)
    if (snapshot) run.push(snapshot)
  }
  return run
}

export function createDisplayAwareLinkProvider(
  terminal: Terminal,
  tracker: LinkContinuityTracker,
  activate: TerminalLinkActivator,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const rows = buildRun(terminal, tracker, Math.max(0, bufferLineNumber - 1))
      const chars = rows.flatMap((row) => row.chars)
      callback(linksInRun(rows, chars, terminal.cols, activate))
    },
  }
}

function registerCursorPositionHandler(
  terminal: Terminal,
  tracker: LinkContinuityTracker,
  identifier: IFunctionIdentifier,
): IDisposable {
  return terminal.parser.registerCsiHandler(identifier, (params) => {
    const row = numberParam(params[0], 1)
    const column = numberParam(params[1], 1)
    if (column === 1 && row >= 1 && row <= terminal.rows) {
      const active = terminal.buffer.active
      tracker.markRowStart({ bufferType: active.type, row: active.viewportY + row - 1 })
    }
    return false
  })
}

function shouldClearForErase(params: Array<number | number[]>): boolean {
  return numberParam(params[0], 0) === 2 || numberParam(params[0], 0) === 3
}

export function installTerminalLinkHandling(
  terminal: Terminal,
  activate: TerminalLinkActivator,
): IDisposable {
  const tracker = createLinkContinuityTracker()
  const disposables: IDisposable[] = [
    terminal.registerLinkProvider(createDisplayAwareLinkProvider(terminal, tracker, activate)),
    registerCursorPositionHandler(terminal, tracker, { final: 'H' }),
    registerCursorPositionHandler(terminal, tracker, { final: 'f' }),
    terminal.parser.registerCsiHandler({ final: 'J' }, (params) => {
      if (shouldClearForErase(params)) tracker.clear()
      return false
    }),
    terminal.parser.registerEscHandler({ final: 'c' }, () => {
      tracker.clear()
      return false
    }),
    terminal.onResize(() => tracker.clear()),
  ]

  return {
    dispose() {
      for (const disposable of disposables) disposable.dispose()
      tracker.clear()
    },
  }
}
