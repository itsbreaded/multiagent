// Pure binary-tree operations over the tmux-style PaneNode layout.
//
// Extracted verbatim from src/renderer/src/store/panes.ts so the layout
// invariants (well-formed splits, focused-pane validation, leaf add/remove/swap)
// can be unit-tested without importing the live Zustand store (which wires IPC
// at module load). No behavior change — these are the same functions, moved.
//
// Importable from both the renderer (bundler resolution) and tests.

import type {
  AgentKind,
  PaneNode,
  PaneLeaf,
  PaneSplit,
  PaneType,
  SplitDirection,
  CwdRepairMapping,
} from './types'

const DEFAULT_AGENT_KIND: AgentKind = 'claude'

export function uuid(): string {
  return crypto.randomUUID()
}

export function makeLeaf(cwd: string, paneType: PaneType = 'shell', agentKind?: AgentKind): PaneLeaf {
  return {
    type: 'leaf',
    id: uuid(),
    paneType,
    agentKind: paneType === 'agent' ? (agentKind ?? DEFAULT_AGENT_KIND) : undefined,
    cwd,
  }
}

export function makeSplit(
  direction: SplitDirection,
  first: PaneNode,
  second: PaneNode,
): PaneSplit {
  return { type: 'split', id: uuid(), direction, ratio: 0.5, first, second }
}

/** Walk the tree and return the leaf with the given id, or null */
export function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeaf(node.first, id) ?? findLeaf(node.second, id)
}

/** Replace the node identified by `targetId` with `replacement` */
export function replaceNode(node: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  if (node.id === targetId) return replacement
  if (node.type === 'leaf') return node
  return {
    ...node,
    first: replaceNode(node.first, targetId, replacement),
    second: replaceNode(node.second, targetId, replacement),
  }
}

/**
 * Remove only the leaf with `removeId` from the tree. Split ids are ignored.
 * Returns null if the sole leaf is removed and preserves identity on no-match.
 */
export function removeLeaf(node: PaneNode, removeId: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === removeId ? null : node
  const first = removeLeaf(node.first, removeId)
  const second = removeLeaf(node.second, removeId)
  if (first === null) return second
  if (second === null) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/**
 * Return a new tree with the two leaf nodes exchanged in their structural positions, in a
 * single traversal pass. The split structure — every split node's id, direction, and
 * ratio — is preserved byte-for-byte; only the two leaves trade slots. Each leaf keeps its
 * own id/data, so live PTYs follow their panes.
 */
export function swapLeaves(node: PaneNode, idA: string, idB: string, leafA: PaneLeaf, leafB: PaneLeaf): PaneNode {
  if (node.type === 'leaf') {
    if (node.id === idA) return leafB
    if (node.id === idB) return leafA
    return node
  }
  return {
    ...node,
    first: swapLeaves(node.first, idA, idB, leafA, leafB),
    second: swapLeaves(node.second, idA, idB, leafA, leafB),
  }
}

/** Update ratio on the split with the given id */
export function updateRatioInTree(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === 'leaf') return node
  if (node.id === splitId) return { ...node, ratio }
  return {
    ...node,
    first: updateRatioInTree(node.first, splitId, ratio),
    second: updateRatioInTree(node.second, splitId, ratio),
  }
}

/**
 * Shallow-patch a leaf by id. Returns the same node when the id is absent or
 * every patch value is Object.is-equal, and otherwise rebuilds only the path
 * to the changed leaf.
 */
export function updateLeaf(node: PaneNode, leafId: string, patch: Partial<PaneLeaf>): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== leafId) return node
    const keys = Object.keys(patch) as (keyof PaneLeaf)[]
    return keys.every((key) => Object.is(node[key], patch[key])) ? node : { ...node, ...patch }
  }
  const first = updateLeaf(node.first, leafId, patch)
  const second = updateLeaf(node.second, leafId, patch)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Mark the agent leaf owning a PTY as exited while preserving untouched identities. */
export function markLeafExitedByPtyId(
  node: PaneNode,
  ptyId: string,
  disconnected: NonNullable<PaneLeaf['agentDisconnected']>,
): { node: PaneNode; exitedLeaf: PaneLeaf | null } {
  if (node.type === 'leaf') {
    if (node.ptyId !== ptyId || node.paneType !== 'agent') return { node, exitedLeaf: null }
    return {
      node: { ...node, ptyId: undefined, agentDisconnected: disconnected },
      exitedLeaf: node,
    }
  }
  const first = markLeafExitedByPtyId(node.first, ptyId, disconnected)
  const second = markLeafExitedByPtyId(node.second, ptyId, disconnected)
  if (!first.exitedLeaf && !second.exitedLeaf) return { node, exitedLeaf: null }
  return {
    node: { ...node, first: first.node, second: second.node },
    exitedLeaf: first.exitedLeaf ?? second.exitedLeaf,
  }
}

/**
 * Walk the tree rewriting every leaf cwd / sessionDetectionCwd through the repair
 * mapping. Returns the updated root plus a `changed` flag so callers can skip
 * no-op updates. Used by sessions:repair-cwd + layout:cwd-repaired.
 */
export function updateCwdsInTree(
  node: PaneNode,
  mapping: CwdRepairMapping,
  replace: (value: string, mapping: CwdRepairMapping) => string,
): { node: PaneNode; changed: boolean } {
  if (node.type === 'leaf') {
    const cwd = replace(node.cwd, mapping)
    const sessionDetectionCwd = node.sessionDetectionCwd
      ? replace(node.sessionDetectionCwd, mapping)
      : undefined
    const changed = cwd !== node.cwd || sessionDetectionCwd !== node.sessionDetectionCwd
    return {
      node: changed ? { ...node, cwd, sessionDetectionCwd } : node,
      changed,
    }
  }
  const first = updateCwdsInTree(node.first, mapping, replace)
  const second = updateCwdsInTree(node.second, mapping, replace)
  if (!first.changed && !second.changed) return { node, changed: false }
  return { node: { ...node, first: first.node, second: second.node }, changed: true }
}

/** Collect all leaf ids in tree order */
export function collectLeafIds(node: PaneNode): string[] {
  return collectLeaves(node).map((leaf) => leaf.id)
}

/** Collect all leaves (in tree order) as full PaneLeaf objects. */
export function collectLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return [...collectLeaves(node.first), ...collectLeaves(node.second)]
}

/** Find a leaf by its agent/session ID pair */
export function findLeafBySessionId(node: PaneNode, agentKind: AgentKind, sessionId: string): PaneLeaf | null {
  if (node.type === 'leaf') {
    return node.agentKind === agentKind && node.sessionId === sessionId ? node : null
  }
  return findLeafBySessionId(node.first, agentKind, sessionId) ?? findLeafBySessionId(node.second, agentKind, sessionId)
}
