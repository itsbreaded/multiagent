import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeTabDragPayload,
  encodeTabDragPayload,
  setTabDragData,
  TAB_DRAG_MIME,
  type TabDragPayload,
} from './tabDrag'
import { PANE_DRAG_MIME } from './paneDrag'
import type { Tab } from '../../../shared/types'

function tab(): Tab {
  return { id: 'tab-1', focusedPaneId: 'pane-1' }
}

function dataTransfer(): DataTransfer {
  return new DataTransfer()
}

const payload: TabDragPayload = { tab: tab(), ptyIds: ['pty-1'], sourceWindowId: 7 }

afterEach(() => {
  expect(TAB_DRAG_MIME).not.toBe(PANE_DRAG_MIME)
})

describe('sidebar tab drag payload', () => {
  it('round-trips a tab snapshot, PTY ids, and source window', () => {
    expect(JSON.parse(encodeTabDragPayload(payload))).toEqual(payload)
    const dt = dataTransfer()
    setTabDragData(dt, payload)
    expect(dt.types).toContain(TAB_DRAG_MIME)
    expect(dt.effectAllowed).toBe('move')
    expect(decodeTabDragPayload(dt)).toEqual(payload)
  })

  it.each([
    '',
    '{bad json',
    JSON.stringify({ tab: { id: 'tab-1' }, ptyIds: ['pty-1'], sourceWindowId: '7' }),
    JSON.stringify({ tab: { id: 'tab-1' }, ptyIds: [1], sourceWindowId: 7 }),
  ])('rejects malformed payload %s', (raw) => {
    const dt = dataTransfer()
    if (raw) dt.setData(TAB_DRAG_MIME, raw)
    expect(decodeTabDragPayload(dt)).toBeNull()
  })
})
