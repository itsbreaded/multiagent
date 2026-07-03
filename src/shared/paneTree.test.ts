import { describe, it, expect } from 'vitest'
import type { PaneNode, PaneLeaf } from './types'
import {
  makeLeaf,
  makeSplit,
  findLeaf,
  replaceNode,
  removeLeaf,
  swapLeaves,
  updateRatioInTree,
  updateLeaf,
  updateCwdsInTree,
  collectLeafIds,
  collectLeaves,
  markLeafExitedByPtyId,
  findLeafBySessionId,
} from './paneTree'
import { replaceCwdPrefix } from './cwdRepair'

// Deterministic leaf builder so tree assertions don't depend on crypto.randomUUID.
function L(id: string, overrides: Partial<PaneLeaf> = {}): PaneLeaf {
  return { type: 'leaf', id, paneType: 'shell', cwd: 'C:\\proj', ...overrides }
}

describe('makeLeaf / makeSplit', () => {
  it('makeLeaf assigns a fresh id, type, and cwd', () => {
    const a = makeLeaf('C:\\a', 'shell')
    const b = makeLeaf('C:\\b', 'shell')
    expect(a.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
    expect(a).toMatchObject({ type: 'leaf', paneType: 'shell', cwd: 'C:\\a' })
  })

  it('makeLeaf defaults an agent pane to claude', () => {
    expect(makeLeaf('C:\\a', 'agent').agentKind).toBe('claude')
    expect(makeLeaf('C:\\a', 'agent', 'codex').agentKind).toBe('codex')
    expect(makeLeaf('C:\\a', 'shell').agentKind).toBeUndefined()
  })

  it('makeSplit wraps two nodes with a 0.5 ratio and a fresh id', () => {
    const split = makeSplit('vertical', L('L1'), L('L2'))
    expect(split.type).toBe('split')
    expect(split.ratio).toBe(0.5)
    expect(split.first.id).toBe('L1')
    expect(split.second.id).toBe('L2')
  })
})

describe('findLeaf', () => {
  // ((L1)(L2 L3)) — a left leaf and a right split.
  const tree: PaneNode = makeSplit('vertical', L('L1'), makeSplit('horizontal', L('L2'), L('L3')))

  it('finds a shallow leaf', () => {
    expect(findLeaf(tree, 'L1')?.id).toBe('L1')
  })
  it('finds a nested leaf', () => {
    expect(findLeaf(tree, 'L3')?.id).toBe('L3')
  })
  it('returns null when absent', () => {
    expect(findLeaf(tree, 'nope')).toBeNull()
  })
})

describe('replaceNode', () => {
  it('replaces the node whose id matches, leaving siblings intact', () => {
    const tree: PaneNode = makeSplit('vertical', L('L1'), L('L2'))
    const next = replaceNode(tree, 'L1', L('L1X'))
    expect(findLeaf(next, 'L1')).toBeNull()
    expect(findLeaf(next, 'L1X')?.id).toBe('L1X')
    expect(findLeaf(next, 'L2')?.id).toBe('L2')
  })
})

describe('removeLeaf', () => {
  it('returns null when removing the only leaf', () => {
    expect(removeLeaf(L('L1'), 'L1')).toBeNull()
  })
  it('collapses a split to its surviving child when a direct child is removed', () => {
    const tree: PaneNode = makeSplit('vertical', L('L1'), L('L2'))
    expect(removeLeaf(tree, 'L1')?.id).toBe('L2')
    expect(removeLeaf(tree, 'L2')?.id).toBe('L1')
  })
  it('removes a nested leaf and keeps the tree well-formed', () => {
    const tree: PaneNode = makeSplit('vertical', L('L1'), makeSplit('horizontal', L('L2'), L('L3')))
    const next = removeLeaf(tree, 'L3')!
    expect(findLeaf(next, 'L3')).toBeNull()
    expect(collectLeafIds(next).sort()).toEqual(['L1', 'L2'])
  })
  it('leaves an unrelated leaf untouched', () => {
    const tree: PaneNode = makeSplit('vertical', L('L1'), L('L2'))
    expect(removeLeaf(tree, 'missing')).toBe(tree)
  })
  it('ignores split ids', () => {
    const inner = makeSplit('horizontal', L('L2'), L('L3'))
    const tree: PaneNode = makeSplit('vertical', L('L1'), inner)
    expect(removeLeaf(tree, inner.id)).toBe(tree)
    expect(collectLeafIds(tree)).toEqual(['L1', 'L2', 'L3'])
  })
})

describe('swapLeaves', () => {
  it('trades two leaves while preserving every split id/direction/ratio', () => {
    const LA = L('A', { cwd: 'C:\\a' })
    const LB = L('B', { cwd: 'C:\\b' })
    const split = makeSplit('vertical', LA, LB)
    const splitId = split.id
    const swapped = swapLeaves(split, 'A', 'B', LA, LB)
    expect(swapped.type).toBe('split')
    if (swapped.type === 'split') {
      expect(swapped.id).toBe(splitId) // split node identity preserved
      expect(swapped.first).toBe(LB)   // A's old slot now holds B
      expect(swapped.second).toBe(LA)  // B's old slot now holds A
    }
  })
})

describe('updateRatioInTree / updateLeaf', () => {
  it('updates the ratio of the targeted split only', () => {
    const inner = makeSplit('horizontal', L('L2'), L('L3'))
    const tree = makeSplit('vertical', L('L1'), inner)
    const next = updateRatioInTree(tree, inner.id, 0.25)
    // The outer split keeps its 0.5 ratio; the inner split is updated to 0.25.
    expect(next.type).toBe('split')
    if (next.type === 'split') expect(next.ratio).toBe(0.5)
    const innerNext = next.type === 'split' ? next.second : null
    expect(innerNext && innerNext.type === 'split' && innerNext.ratio).toBe(0.25)
  })

  it('patches a single leaf field', () => {
    const tree: PaneNode = L('L1')
    const next = updateLeaf(tree, 'L1', { customName: 'Build' })
    expect(findLeaf(next, 'L1')?.customName).toBe('Build')
  })

  it('preserves identity for missing and identical patches', () => {
    const tree = makeSplit('vertical', L('L1'), L('L2'))
    expect(updateLeaf(tree, 'missing', { customName: 'x' })).toBe(tree)
    expect(updateLeaf(tree, 'L1', { cwd: 'C:\\proj', ptyId: undefined })).toBe(tree)
  })

  it('rebuilds only the changed path', () => {
    const inner = makeSplit('horizontal', L('L2'), L('L3'))
    const tree = makeSplit('vertical', L('L1'), inner)
    const next = updateLeaf(tree, 'L3', { customName: 'Build' })
    expect(next).not.toBe(tree)
    expect(next.type).toBe('split')
    if (next.type === 'split') {
      expect(next.first).toBe(tree.first)
      expect(next.second).not.toBe(tree.second)
      if (next.second.type === 'split') expect(next.second.first).toBe(inner.first)
    }
  })
})

describe('markLeafExitedByPtyId', () => {
  const disconnected = { exitCode: 1, signal: 9, at: 123 }

  it('marks an agent and preserves its sibling', () => {
    const agent = L('A', { paneType: 'agent', agentKind: 'claude', ptyId: 'pty-1', sessionId: 's-1' })
    const sibling = L('B')
    const tree = makeSplit('vertical', agent, sibling)
    const result = markLeafExitedByPtyId(tree, 'pty-1', disconnected)
    expect(result.exitedLeaf).toBe(agent)
    expect(result.node).not.toBe(tree)
    expect(result.node.type).toBe('split')
    if (result.node.type === 'split') expect(result.node.second).toBe(sibling)
    expect(findLeaf(result.node, 'A')).toMatchObject({ ptyId: undefined, agentDisconnected: disconnected })
  })

  it('is a no-op for unknown PTYs and shell panes', () => {
    const shell = L('S', { ptyId: 'pty-shell' })
    expect(markLeafExitedByPtyId(shell, 'missing', disconnected)).toEqual({ node: shell, exitedLeaf: null })
    expect(markLeafExitedByPtyId(shell, 'pty-shell', disconnected)).toEqual({ node: shell, exitedLeaf: null })
  })
})

describe('collectLeafIds / findLeafBySessionId', () => {
  it('collectLeafIds preserves tree order', () => {
    const tree: PaneNode = makeSplit('vertical', L('L1'), makeSplit('horizontal', L('L2'), L('L3')))
    expect(collectLeafIds(tree)).toEqual(['L1', 'L2', 'L3'])
  })

  it('findLeafBySessionId matches the agent/session pair', () => {
    const agent = L('L1', { paneType: 'agent', agentKind: 'claude', sessionId: 's-1' })
    const tree: PaneNode = makeSplit('vertical', agent, L('L2'))
    expect(findLeafBySessionId(tree, 'claude', 's-1')?.id).toBe('L1')
    expect(findLeafBySessionId(tree, 'codex', 's-1')).toBeNull()
  })
})

describe('updateCwdsInTree', () => {
  it('rewrites leaf cwds and sessionDetectionCwds, reporting change', () => {
    const mapping = { oldCwd: 'C:\\old', newCwd: 'C:\\new' }
    const tree: PaneNode = makeSplit(
      'vertical',
      L('L1', { cwd: 'C:\\old\\sub', sessionDetectionCwd: 'C:\\old' }),
      L('L2', { cwd: 'C:\\unrelated' }),
    )
    const { node, changed } = updateCwdsInTree(tree, mapping, replaceCwdPrefix)
    expect(changed).toBe(true)
    expect(findLeaf(node, 'L1')?.cwd).toBe('C:\\new\\sub')
    expect(findLeaf(node, 'L1')?.sessionDetectionCwd).toBe('C:\\new')
    expect(findLeaf(node, 'L2')?.cwd).toBe('C:\\unrelated')
  })

  it('reports no change when nothing matches', () => {
    const mapping = { oldCwd: 'C:\\old', newCwd: 'C:\\new' }
    const tree: PaneNode = L('L1', { cwd: 'C:\\unrelated' })
    const { changed } = updateCwdsInTree(tree, mapping, replaceCwdPrefix)
    expect(changed).toBe(false)
  })
})

describe('collectLeaves', () => {
  it('returns the single leaf for a leaf root', () => {
    const leaf = L('L1')
    expect(collectLeaves(leaf)).toEqual([leaf])
  })

  it('returns all leaves in tree order for a nested split', () => {
    const a = L('A')
    const b = L('B')
    const c = L('C')
    const tree: PaneNode = makeSplit('vertical', makeSplit('horizontal', a, b), c)
    expect(collectLeaves(tree)).toEqual([a, b, c])
  })

  it('collectLeafIds matches collectLeaves ids', () => {
    const a = L('A')
    const b = L('B')
    const tree: PaneNode = makeSplit('vertical', a, b)
    expect(collectLeafIds(tree)).toEqual(collectLeaves(tree).map((l) => l.id))
  })
})
