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
})
