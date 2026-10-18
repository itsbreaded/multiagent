import { describe, expect, it } from 'vitest'
import type { Tab } from './types'
import { JIRA_FEATURE_KEY, normalizeDestination, normalizeSidebarOrder, syncProjectOrder } from './workspaceNavigation'

const tabs: Tab[] = [
  { id: 'alpha', focusedPaneId: '' },
  { id: 'beta', focusedPaneId: '' },
]

describe('workspace navigation normalization', () => {
  it('keeps the mixed order while removing duplicates and stale project references', () => {
    expect(normalizeSidebarOrder([
      JIRA_FEATURE_KEY,
      'project:beta',
      'project:beta',
      'project:removed',
    ], tabs, true)).toEqual([JIRA_FEATURE_KEY, 'project:beta', 'project:alpha'])
  })

  it('puts Jira mentions first by default while preserving an explicit reordered slot', () => {
    expect(normalizeSidebarOrder([], tabs, true)).toEqual([
      JIRA_FEATURE_KEY,
      'project:alpha',
      'project:beta',
    ])
    expect(normalizeSidebarOrder(['project:alpha', JIRA_FEATURE_KEY, 'project:beta'], tabs, true))
      .toEqual(['project:alpha', JIRA_FEATURE_KEY, 'project:beta'])
  })

  it('falls back to a valid project when a saved feature is hidden or a project was removed', () => {
    expect(normalizeDestination({ kind: 'feature', featureId: 'jira-mentions' }, tabs, 'beta', false))
      .toEqual({ kind: 'project', tabId: 'beta' })
    expect(normalizeDestination({ kind: 'project', tabId: 'removed' }, tabs, 'removed', true))
      .toEqual({ kind: 'project', tabId: 'beta' })
    expect(normalizeDestination({ kind: 'feature', featureId: 'jira-mentions' }, tabs, 'beta', true))
      .toEqual({ kind: 'feature', featureId: 'jira-mentions' })
  })

  it('preserves the feature slot while tab membership changes', () => {
    const nextTabs: Tab[] = [tabs[1], tabs[0], { id: 'gamma', focusedPaneId: '' }]
    expect(syncProjectOrder(['project:alpha', JIRA_FEATURE_KEY, 'project:beta'], nextTabs))
      .toEqual(['project:beta', JIRA_FEATURE_KEY, 'project:alpha', 'project:gamma'])
  })
})
