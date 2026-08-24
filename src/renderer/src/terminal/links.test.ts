import { Terminal as XTerm } from '@xterm/xterm'
import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  createPrimaryLinkActivator,
  createDisplayAwareLinkProvider,
  createLinkContinuityTracker,
  installTerminalLinkHandling,
  isPrimaryLinkActivation,
} from './links'

function makeLine(text: string, cols: number, isWrapped = false): IBufferLine {
  const cells = text.padEnd(cols, ' ').slice(0, cols).split('')
  return {
    isWrapped,
    length: cols,
    getCell(column: number) {
      if (column < 0 || column >= cols) return undefined
      const char = cells[column] ?? ' '
      return {
        getWidth: () => 1,
        getChars: () => char === ' ' ? '' : char,
      }
    },
    translateToString: () => text,
  } as unknown as IBufferLine
}

function makeTerminal(lines: IBufferLine[], cols: number): Terminal {
  return {
    cols,
    rows: lines.length,
    buffer: {
      active: {
        type: 'normal',
        viewportY: 0,
        getLine: (row: number) => lines[row],
      },
    },
  } as unknown as Terminal
}

function getLinks(provider: ILinkProvider, line: number): Promise<ILink[]> {
  return collectLinks(provider, line)
}

function collectLinks(provider: ILinkProvider, line: number): Promise<ILink[]> {
  return new Promise((resolve) => provider.provideLinks(line, (links) => resolve(links ?? [])))
}

describe('terminal link handling', () => {
  it('joins a URL across naturally wrapped rows', async () => {
    const cols = 24
    const url = 'https://example.com/very-long-path?token=abc123-more'
    const lines = [
      makeLine(url.slice(0, cols), cols),
      makeLine(url.slice(cols, cols * 2), cols, true),
      makeLine(url.slice(cols * 2), cols, true),
    ]
    const provider = createDisplayAwareLinkProvider(
      makeTerminal(lines, cols),
      createLinkContinuityTracker(),
      vi.fn(),
    )

    const links = await getLinks(provider, 1)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe(url)
    expect(links[0].range.start).toEqual({ x: 1, y: 1 })
    expect(links[0].range.end.y).toBe(3)
  })

  it('joins cursor-positioned rows only when row-start evidence exists', async () => {
    const cols = 24
    const url = 'https://example.com/very-long-path?token=abc123-more'
    const lines = [
      makeLine(url.slice(0, cols), cols),
      makeLine(url.slice(cols, cols * 2), cols),
      makeLine(url.slice(cols * 2), cols),
    ]
    const terminal = makeTerminal(lines, cols)
    const tracker = createLinkContinuityTracker()
    tracker.markRowStart({ bufferType: 'normal', row: 0 })
    tracker.markRowStart({ bufferType: 'normal', row: 1 })
    tracker.markRowStart({ bufferType: 'normal', row: 2 })
    const provider = createDisplayAwareLinkProvider(terminal, tracker, vi.fn())

    const links = await getLinks(provider, 2)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe(url)
    expect(links[0].range.start).toEqual({ x: 1, y: 1 })
    expect(links[0].range.end.y).toBe(3)

    const withoutEvidence = createDisplayAwareLinkProvider(
      terminal,
      createLinkContinuityTracker(),
      vi.fn(),
    )
    await expect(getLinks(withoutEvidence, 1)).resolves.toHaveLength(0)
  })

  it('does not merge a URL with a non-contiguous row', async () => {
    const cols = 32
    const url = 'https://example.com/resource'
    const lines = [
      makeLine(`${url}   `, cols),
      makeLine('unrelated-follow-up-text', cols),
    ]
    const provider = createDisplayAwareLinkProvider(
      makeTerminal(lines, cols),
      createLinkContinuityTracker(),
      vi.fn(),
    )

    const links = await getLinks(provider, 1)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe(url)
  })

  it('fails closed when a cursor-positioned boundary has no URL continuation cue', async () => {
    const first = 'https://example.com/previous-path'
    const cols = first.length
    for (const nextRow of ['evil.com', 'unrelated']) {
      const tracker = createLinkContinuityTracker()
      tracker.markRowStart({ bufferType: 'normal', row: 0 })
      tracker.markRowStart({ bufferType: 'normal', row: 1 })
      const provider = createDisplayAwareLinkProvider(
        makeTerminal([makeLine(first, cols), makeLine(nextRow, cols)], cols),
        tracker,
        vi.fn(),
      )

      await expect(getLinks(provider, 1)).resolves.toHaveLength(0)
    }
  })

  it('fails closed when a URL reaches the bounded scan limit', async () => {
    const cols = 2100
    const line = makeLine(`https://example.com/${'a'.repeat(2050)}`, cols)
    const provider = createDisplayAwareLinkProvider(
      makeTerminal([line], cols),
      createLinkContinuityTracker(),
      vi.fn(),
    )

    await expect(getLinks(provider, 1)).resolves.toHaveLength(0)
  })

  it('filters every non-primary mouse button before activation', () => {
    expect(isPrimaryLinkActivation(new MouseEvent('mouseup', { button: 0 }))).toBe(true)
    expect(isPrimaryLinkActivation(new MouseEvent('mouseup', { button: 1 }))).toBe(false)
    expect(isPrimaryLinkActivation(new MouseEvent('mouseup', { button: 2 }))).toBe(false)
    expect(isPrimaryLinkActivation(new MouseEvent('mouseup', { button: auxiliaryButton }))).toBe(false)
  })

  it('uses the same primary-button gate for explicit and detected link callbacks', () => {
    const activate = vi.fn()
    const open = createPrimaryLinkActivator(activate)
    const uri = 'https://example.com/path'

    open(new MouseEvent('mouseup', { button: 2 }), uri)
    open(new MouseEvent('mouseup', { button: 1 }), uri)
    expect(activate).not.toHaveBeenCalled()

    const event = new MouseEvent('mouseup', { button: 0 })
    open(event, uri)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(event, uri)
  })

  it('applies the primary-button gate to a real xterm OSC-8 provider link', async () => {
    const uri = 'https://example.com/osc8-target'
    const activate = vi.fn()
    const terminal = new XTerm({
      allowProposedApi: true,
      linkHandler: { activate: createPrimaryLinkActivator(activate) },
    })
    const host = document.createElement('div')
    document.body.append(host)
    terminal.open(host)
    await new Promise<void>((resolve) => {
      const parsed = terminal.onWriteParsed(() => {
        parsed.dispose()
        resolve()
      })
      terminal.write(`\x1b]8;;${uri}\x07Explicit Link\x1b]8;;\x07`)
    })

    const core = (terminal as unknown as {
      _core: { _linkProviderService: { linkProviders: ILinkProvider[] } }
    })._core
    const provider = core._linkProviderService.linkProviders[0]
    const links = await collectLinks(provider, 1)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe(uri)

    links[0].activate(new MouseEvent('mouseup', { button: 2 }), uri)
    expect(activate).not.toHaveBeenCalled()
    const leftClick = new MouseEvent('mouseup', { button: 0 })
    links[0].activate(leftClick, uri)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(leftClick, uri)
    terminal.dispose()
    host.remove()
  })

  it('registers one provider and records CSI row-start evidence without consuming it', () => {
    const cols = 24
    const lines = [makeLine('https://example.com/part', cols)]
    const csiHandlers: Array<{ id: { final: string }; callback: (params: Array<number | number[]>) => boolean }> = []
    const registered: ILinkProvider[] = []
    const terminal = {
      ...makeTerminal(lines, cols),
      parser: {
        registerCsiHandler: (id: { final: string }, callback: (params: Array<number | number[]>) => boolean) => {
          csiHandlers.push({ id, callback })
          return { dispose() {} }
        },
        registerEscHandler: (_id: { final: string }, _callback: () => boolean) => ({ dispose() {} }),
      },
      registerLinkProvider: (provider: ILinkProvider) => {
        registered.push(provider)
        return { dispose() {} }
      },
      onResize: (_callback: () => void) => ({ dispose() {} }),
    } as unknown as Terminal

    const handle = installTerminalLinkHandling(terminal, vi.fn())
    expect(registered).toHaveLength(1)
    const cup = csiHandlers.find((entry) => entry.id.final === 'H')
    expect(cup).toBeDefined()
    expect(cup?.callback([1, 1])).toBe(false)
    handle.dispose()
  })

  it('connects CSI row-start evidence to cursor-positioned link reconstruction', async () => {
    const cols = 24
    const url = 'https://example.com/very-long-path?token=abc123-more'
    const lines = [
      makeLine(url.slice(0, cols), cols),
      makeLine(url.slice(cols, cols * 2), cols),
      makeLine(url.slice(cols * 2), cols),
    ]
    const csiHandlers: Array<{ id: { final: string }; callback: (params: Array<number | number[]>) => boolean }> = []
    const registered: ILinkProvider[] = []
    const terminal = {
      ...makeTerminal(lines, cols),
      parser: {
        registerCsiHandler: (id: { final: string }, callback: (params: Array<number | number[]>) => boolean) => {
          csiHandlers.push({ id, callback })
          return { dispose() {} }
        },
        registerEscHandler: (_id: { final: string }, _callback: () => boolean) => ({ dispose() {} }),
      },
      registerLinkProvider: (provider: ILinkProvider) => {
        registered.push(provider)
        return { dispose() {} }
      },
      onResize: (_callback: () => void) => ({ dispose() {} }),
    } as unknown as Terminal

    const handle = installTerminalLinkHandling(terminal, vi.fn())
    const cup = csiHandlers.find((entry) => entry.id.final === 'H')
    expect(cup).toBeDefined()
    cup?.callback([1, 1])
    cup?.callback([2, 1])
    cup?.callback([3, 1])

    const links = await collectLinks(registered[0], 2)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe(url)
    expect(links[0].range.start).toEqual({ x: 1, y: 1 })
    expect(links[0].range.end.y).toBe(3)
    handle.dispose()
  })
})

const auxiliaryButton = 3
