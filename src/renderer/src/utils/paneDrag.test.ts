import { afterEach, describe, it, expect, vi } from 'vitest'
import type React from 'react'
import {
  encodePaneDragPayload,
  decodePaneDragPayload,
  setPaneDragData,
  paneDragSourceId,
  PANE_DRAG_MIME,
  type PaneDragPayload,
  TAB_DRAG_MIME,
  absorbDroppedTab,
  transferDroppedPane,
} from './paneDrag'
import type { PaneLeaf, Tab } from '../../../shared/types'

function leaf(overrides: Partial<PaneLeaf> = {}): PaneLeaf {
  return {
    type: 'leaf',
    id: 'pane-1',
    paneType: 'shell',
    cwd: 'C:\\proj',
    ...overrides,
  }
}

function makeDataTransfer(): DataTransfer {
  return new DataTransfer()
}

function dragEvent(dataTransfer: DataTransfer): React.DragEvent {
  return { dataTransfer, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.DragEvent
}

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'ipc', { configurable: true, value: undefined })
})

describe('encode / decode round-trip', () => {
  const payload: PaneDragPayload = {
    pane: leaf(),
    sourceTabId: 'tab-1',
    sourceWindowId: 7,
  }

  it('round-trips a valid payload', () => {
    const dt = makeDataTransfer()
    setPaneDragData(dt, payload)
    expect(decodePaneDragPayload(dt)).toEqual(payload)
  })

  it('encode produces JSON that includes the pane id', () => {
    expect(encodePaneDragPayload(payload)).toContain('pane-1')
  })
})

describe('paneDragSourceId', () => {
  it('returns the source pane id set on the data transfer', () => {
    const dt = makeDataTransfer()
    setPaneDragData(dt, { pane: leaf({ id: 'src-9' }), sourceTabId: 't', sourceWindowId: 1 })
    expect(paneDragSourceId(dt)).toBe('src-9')
  })

  it('returns null when no source marker is present', () => {
    const dt = makeDataTransfer()
    dt.setData('text/plain', 'x')
    expect(paneDragSourceId(dt)).toBeNull()
  })
})

describe('decodePaneDragPayload validation', () => {
  it('returns null when the pane drag MIME is absent', () => {
    const dt = makeDataTransfer()
    expect(decodePaneDragPayload(dt)).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const dt = makeDataTransfer()
    dt.setData(PANE_DRAG_MIME, '{not json')
    expect(decodePaneDragPayload(dt)).toBeNull()
  })

  it('returns null when the payload shape is wrong', () => {
    const dt = makeDataTransfer()
    dt.setData(PANE_DRAG_MIME, JSON.stringify({ pane: { type: 'split' }, sourceTabId: 't', sourceWindowId: 1 }))
    expect(decodePaneDragPayload(dt)).toBeNull()

    const dt2 = makeDataTransfer()
    dt2.setData(PANE_DRAG_MIME, JSON.stringify({ pane: leaf(), sourceTabId: 't', sourceWindowId: 'not-a-number' }))
    expect(decodePaneDragPayload(dt2)).toBeNull()
  })
})

describe('rejected cross-window drops', () => {
  it('rolls back an optimistically received tab and logs the rejection', async () => {
    const tab: Tab = { id: 'tab-1', rootNode: leaf(), focusedPaneId: 'pane-1' }
    const dt = makeDataTransfer()
    dt.setData(TAB_DRAG_MIME, JSON.stringify({ tab, ptyIds: ['pty-1'], sourceWindowId: 7 }))
    const invoke = vi.fn().mockRejectedValue(new Error('timed out'))
    Object.defineProperty(window, 'ipc', { configurable: true, value: { invoke } })
    const receiveTab = vi.fn(), removeTabLocally = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(absorbDroppedTab(dragEvent(dt), 8, { receiveTab, removeTabLocally })).toBe(true)
    await vi.waitFor(() => expect(removeTabLocally).toHaveBeenCalledWith('tab-1'))
    expect(error).toHaveBeenCalledWith('tab:absorb failed', expect.any(Error))
  })

  it('catches and logs a rejected pane transfer', async () => {
    const dt = makeDataTransfer()
    setPaneDragData(dt, { pane: leaf(), sourceTabId: 'tab-1', sourceWindowId: 7 })
    const invoke = vi.fn().mockRejectedValue(new Error('window closed'))
    Object.defineProperty(window, 'ipc', { configurable: true, value: { invoke } })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(transferDroppedPane(dragEvent(dt), 'tab-2', 8, { movePaneToTab: vi.fn() })).toBe(true)
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('pane:transfer failed', expect.any(Error)))
  })
})
