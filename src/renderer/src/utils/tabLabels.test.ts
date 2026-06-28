import { describe, it, expect } from 'vitest'
import {
  findLeafById,
  firstLeaf,
  collectLeaves,
  paneLabelText,
  computeLabels,
} from './tabLabels'
import type { PaneNode, PaneLeaf, Tab, Session } from '../../../shared/types'

function leaf(overrides: Partial<PaneLeaf>): PaneLeaf {
  return { type: 'leaf', id: 'L1', paneType: 'shell', cwd: 'C:\\proj', ...overrides }
}

// A two-leaf split: [L1, L2] in tree order.
const split: PaneNode = {
  type: 'split',
  id: 'S1',
  direction: 'vertical',
  ratio: 0.5,
  first: leaf({ id: 'L1' }),
  second: leaf({ id: 'L2' }),
}

describe('findLeafById', () => {
  it('finds a leaf in the first branch', () => {
    expect(findLeafById(split, 'L1')?.id).toBe('L1')
  })
  it('finds a leaf in the second branch', () => {
    expect(findLeafById(split, 'L2')?.id).toBe('L2')
  })
  it('returns null for an absent id', () => {
    expect(findLeafById(split, 'nope')).toBeNull()
  })
})

describe('firstLeaf', () => {
  it('returns the first leaf in tree order', () => {
    expect(firstLeaf(split)?.id).toBe('L1')
  })
})

describe('collectLeaves', () => {
  it('returns leaves in tree order', () => {
    expect(collectLeaves(split).map((l) => l.id)).toEqual(['L1', 'L2'])
  })
})

describe('paneLabelText', () => {
  it('uses the last cwd segment for a shell pane', () => {
    expect(paneLabelText(leaf({ cwd: 'C:\\a\\b\\proj' }), [])).toBe('proj')
  })
  it('normalizes forward-slash cwds too', () => {
    expect(paneLabelText(leaf({ cwd: '/home/user/proj' }), [])).toBe('proj')
  })
  it('falls back to "Shell" for a root cwd', () => {
    expect(paneLabelText(leaf({ cwd: '\\' }), [])).toBe('Shell')
  })
  it('prefixes a custom name', () => {
    expect(paneLabelText(leaf({ cwd: 'C:\\proj', customName: 'Build' }), [])).toBe('Build · proj')
  })
  it('uses the session project name for an agent pane with a matched session', () => {
    const session: Session = {
      agentKind: 'claude', sessionId: 's1', cwd: 'C:\\proj', cwdExists: true,
      projectName: 'work/proj', displayName: null, gitBranch: null,
      firstMessage: null, lastMessage: null, firstActivity: null, lastActivity: null,
      messageCount: 0, transcriptPath: '', status: 'resumable',
    }
    const label = paneLabelText(leaf({ paneType: 'agent', agentKind: 'claude', sessionId: 's1' }), [session])
    expect(label).toBe('proj')
  })
  it('falls back to the cwd segment for an agent pane without a session', () => {
    const label = paneLabelText(leaf({ paneType: 'agent', agentKind: 'claude', cwd: 'C:\\proj' }), [])
    expect(label).toBe('proj')
  })
})

describe('computeLabels', () => {
  function tab(id: string, overrides: Partial<Tab>): Tab {
    return { id, focusedPaneId: 'L1', ...overrides }
  }

  it('uses customLabel when present', () => {
    const tabs = [tab('t1', { customLabel: 'My Tab', rootNode: split })]
    const labels = computeLabels(tabs, [])
    expect(labels.get('t1')).toBe('My Tab')
  })

  it('numbers otherwise-identical "Shell" labels', () => {
    const tabs = [
      tab('t1', { rootNode: leaf({ id: 'L1' }) }),
      tab('t2', { rootNode: leaf({ id: 'L2', cwd: '\\' }) }),
    ]
    const labels = computeLabels(tabs, [])
    // L1 cwd is C:\proj -> 'proj'; L2 cwd '\' -> 'Shell'
    expect(labels.get('t1')).toBe('proj')
    expect(labels.get('t2')).toBe('Shell')
  })

  it('labels empty tabs as "Tab N"', () => {
    const tabs = [tab('t1', { rootNode: undefined })]
    const labels = computeLabels(tabs, [])
    expect(labels.get('t1')).toBe('Tab 1')
  })

  it('avoids colliding with an existing customLabel when numbering Tab N', () => {
    const tabs = [
      tab('t1', { customLabel: 'Tab 1' }), // occupies "tab 1"
      tab('t2', { rootNode: undefined }),
    ]
    const labels = computeLabels(tabs, [])
    expect(labels.get('t2')).toBe('Tab 2')
  })
})
