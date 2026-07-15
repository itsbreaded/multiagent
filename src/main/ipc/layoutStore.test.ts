import { describe, expect, it } from 'vitest'
import { normalizeTabsForLayout, rewriteLayoutCwds } from './layoutStore'

describe('layoutStore pure helpers', () => {
  it('normalizes restored tabs as attached and passes non-arrays through', () => {
    expect(normalizeTabsForLayout(null)).toBeNull()
    expect(normalizeTabsForLayout([{ id: 'a', detached: true }, 'invalid'])).toEqual([
      { id: 'a', detached: false },
      'invalid',
    ])
  })

  it('rewrites and counts cwd fields throughout split trees', () => {
    const layout = {
      tabs: [{
        defaultCwd: 'C:\\old\\project',
        rootNode: {
          type: 'split',
          first: { type: 'leaf', cwd: 'C:\\old\\one', sessionDetectionCwd: 'C:\\old\\detect' },
          second: { type: 'leaf', cwd: 'D:\\other' },
        },
      }],
    }
    expect(rewriteLayoutCwds(layout, { oldCwd: 'C:\\old', newCwd: 'C:\\new' })).toEqual({
      changed: true,
      count: 3,
    })
    expect(layout.tabs[0].defaultCwd).toBe('C:\\new\\project')
    expect(layout.tabs[0].rootNode.first.cwd).toBe('C:\\new\\one')
  })

  it('strips promotedFromShell and reverts a phase-1-only promotion to a shell (spec 047)', () => {
    const tabs = [{
      id: 't',
      rootNode: {
        type: 'leaf',
        id: 'p',
        paneType: 'agent',
        agentKind: 'claude',
        promotedFromShell: true,
        cwd: 'C:\\repo',
        ptyId: 'pty-1',
      },
    }]
    const out = normalizeTabsForLayout(tabs) as Array<{ rootNode: Record<string, unknown> }>
    const leaf = out[0].rootNode
    expect(leaf['paneType']).toBe('shell')
    expect(leaf['agentKind']).toBeUndefined()
    expect(leaf['sessionId']).toBeUndefined()
    expect(leaf['promotedFromShell']).toBeUndefined()
  })

  it('keeps a phase-2-linked promoted pane as an agent but strips promotedFromShell (spec 047)', () => {
    const tabs = [{
      id: 't',
      rootNode: {
        type: 'leaf',
        id: 'p',
        paneType: 'agent',
        agentKind: 'claude',
        sessionId: 'linked-session',
        promotedFromShell: true,
        cwd: 'C:\\repo',
      },
    }]
    const out = normalizeTabsForLayout(tabs) as Array<{ rootNode: Record<string, unknown> }>
    const leaf = out[0].rootNode
    expect(leaf['paneType']).toBe('agent')
    expect(leaf['agentKind']).toBe('claude')
    expect(leaf['sessionId']).toBe('linked-session')
    expect(leaf['promotedFromShell']).toBeUndefined()
  })

  it('strips a stray promotedFromShell on a split tree and leaves unrelated panes intact', () => {
    const tabs = [{
      id: 't',
      rootNode: {
        type: 'split',
        first: { type: 'leaf', id: 'a', paneType: 'shell', cwd: 'C:\\a', promotedFromShell: true },
        second: { type: 'leaf', id: 'b', paneType: 'agent', agentKind: 'codex', sessionId: 's', cwd: 'C:\\b' },
      },
    }]
    const out = normalizeTabsForLayout(tabs) as Array<{ rootNode: { first: Record<string, unknown>; second: Record<string, unknown> } }>
    expect(out[0].rootNode.first['promotedFromShell']).toBeUndefined()
    expect(out[0].rootNode.first['paneType']).toBe('shell')
    // Unrelated native agent pane untouched.
    expect(out[0].rootNode.second['agentKind']).toBe('codex')
    expect(out[0].rootNode.second['sessionId']).toBe('s')
  })
})
