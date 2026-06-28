import { describe, it, expect } from 'vitest'
import {
  encodePaneDragPayload,
  decodePaneDragPayload,
  setPaneDragData,
  paneDragSourceId,
  PANE_DRAG_MIME,
  type PaneDragPayload,
} from './paneDrag'
import type { PaneLeaf } from '../../../shared/types'

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
