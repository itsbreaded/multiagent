import type { Tab, WorkspaceDestination } from './types'

export const JIRA_FEATURE_KEY = 'feature:jira-mentions'

export function projectOrderKey(tabId: string): string {
  return `project:${tabId}`
}

export function normalizeSidebarOrder(order: unknown, tabs: readonly Tab[], includeFeature: boolean): string[] {
  const valid = new Set(tabs.map((tab) => projectOrderKey(tab.id)))
  valid.add(JIRA_FEATURE_KEY)
  const result: string[] = []
  if (Array.isArray(order)) {
    for (const item of order) {
      if (typeof item === 'string' && valid.has(item) && !result.includes(item)) result.push(item)
    }
  }
  for (const tab of tabs) {
    const key = projectOrderKey(tab.id)
    if (!result.includes(key)) result.push(key)
  }
  if (includeFeature && !result.includes(JIRA_FEATURE_KEY)) result.unshift(JIRA_FEATURE_KEY)
  return result
}

export function normalizeDestination(
  value: unknown,
  tabs: readonly Tab[],
  activeTabId: string,
  featureVisible: boolean,
): WorkspaceDestination {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<WorkspaceDestination>
    if (candidate.kind === 'feature' && candidate.featureId === 'jira-mentions' && featureVisible) return candidate as WorkspaceDestination
    if (candidate.kind === 'project' && typeof candidate.tabId === 'string' && tabs.some((tab) => tab.id === candidate.tabId)) {
      return { kind: 'project', tabId: candidate.tabId }
    }
  }
  const project = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : (tabs.at(-1)?.id ?? '')
  return { kind: 'project', tabId: project }
}

export function syncProjectOrder(order: readonly string[], tabs: readonly Tab[]): string[] {
  const projectKeys = tabs.map((tab) => projectOrderKey(tab.id))
  let index = 0
  const mixed = order.map((key) => key.startsWith('project:') ? projectKeys[index++] ?? key : key)
  while (index < projectKeys.length) mixed.push(projectKeys[index++])
  return normalizeSidebarOrder(mixed, tabs, order.includes(JIRA_FEATURE_KEY))
}
