import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockIpc, installMockIpc, type MockIpc } from '../../../../tests/mockIpc'
import { useJiraStore } from './jira'

const TEST_BASE_URL = 'https://jira.example.com'

const defaultState = {
  settings: { baseUrl: TEST_BASE_URL, email: '', patterns: [], hasToken: false },
  hydrated: false,
  configVersion: 0,
  labels: {},
  projects: {},
  rows: {},
  suppressedInitialTabs: {},
}

function resetStore(): void {
  useJiraStore.setState(defaultState)
}

function success(issueKey: string, statusName = 'In Progress') {
  return { ok: true, issueKey, issueUrl: `${TEST_BASE_URL}/browse/${issueKey}`, statusName }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  resetStore()
  vi.useRealTimers()
})

describe('useJiraStore', () => {
  it('looks up each matching row once and excludes non-matches', async () => {
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string, value?: string) => {
      if (channel === 'jira:get-settings') return { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true }
      if (channel === 'jira:fetch-status') return success(value as string)
      return { ok: true }
    })
    await useJiraStore.getState().hydrateSettings()
    useJiraStore.getState().syncProjects([
      { tabId: 'one', label: 'DZ-1234' },
      { tabId: 'two', label: 'Notes' },
      { tabId: 'three', label: 'dz-5678 Work' },
    ])
    await flush()
    expect(ipc.invoke.mock.calls.filter((call) => call[0] === 'jira:fetch-status').map((call) => call[1])).toEqual(['DZ-1234', 'dz-5678'])
    expect(useJiraStore.getState().rows.two).toBeUndefined()
    expect(useJiraStore.getState().rows.one?.statusName).toBe('In Progress')
  })

  it('performs one initial lookup after the create flow renames Tab N to a matching key', async () => {
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string, value?: string) => {
      if (channel === 'jira:get-settings') return { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true }
      if (channel === 'jira:fetch-status') return success(value as string)
      return { ok: true }
    })
    await useJiraStore.getState().hydrateSettings()
    useJiraStore.getState().syncProjects([{ tabId: 'new', label: 'Tab 1' }])
    useJiraStore.getState().syncProjects([{ tabId: 'new', label: 'DZ-1234' }])
    await flush()
    expect(ipc.invoke.mock.calls.filter((call) => call[0] === 'jira:fetch-status')).toHaveLength(1)
  })

  it('does not fetch implicitly when settings create a new match', async () => {
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira:get-settings') return { baseUrl: TEST_BASE_URL, email: '', patterns: [], hasToken: false }
      if (channel === 'jira:save-settings') return { ok: true, settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true } }
      return success('DZ-1234')
    })
    await useJiraStore.getState().hydrateSettings()
    useJiraStore.getState().syncProjects([{ tabId: 'one', label: 'DZ-1234' }])
    await useJiraStore.getState().saveSettings({ baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], apiToken: 'token' })
    await flush()
    expect(ipc.invoke.mock.calls.filter((call) => call[0] === 'jira:fetch-status')).toHaveLength(0)
    await useJiraStore.getState().refreshTab('one')
    expect(ipc.invoke.mock.calls.filter((call) => call[0] === 'jira:fetch-status')).toHaveLength(1)
  })

  it('retains a successful result as stale after a failed refresh', async () => {
    const ipc = installMockIpc()
    let requests = 0
    ipc.invoke.mockImplementation(async (channel: string, value?: string) => {
      if (channel === 'jira:get-settings') return { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true }
      if (channel === 'jira:fetch-status') {
        requests += 1
        return requests === 1 ? success(value as string, 'Closed') : { ok: false, issueKey: value, code: 'network', message: 'Jira could not be reached.' }
      }
      return { ok: true }
    })
    await useJiraStore.getState().hydrateSettings()
    useJiraStore.getState().syncProjects([{ tabId: 'one', label: 'DZ-1234' }])
    await flush()
    await useJiraStore.getState().refreshTab('one')
    expect(useJiraStore.getState().rows.one).toMatchObject({ phase: 'stale', statusName: 'Closed', errorCode: 'network', linkable: true })
  })

  it('suppresses an older concurrent response', async () => {
    const ipc = installMockIpc()
    const pending: Array<(value: unknown) => void> = []
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira:get-settings') return { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true }
      if (channel === 'jira:fetch-status') return new Promise((resolve) => pending.push(resolve))
      return { ok: true }
    })
    await useJiraStore.getState().hydrateSettings()
    useJiraStore.getState().syncProjects([{ tabId: 'one', label: 'DZ-1234' }])
    await flush()
    const newerRequest = useJiraStore.getState().refreshTab('one')
    await flush()
    const statusCalls = ipc.invoke.mock.calls.filter((call) => call[0] === 'jira:fetch-status')
    expect(statusCalls).toHaveLength(2)
    pending[1](success('DZ-1234', 'Newest'))
    pending[0](success('DZ-1234', 'Oldest'))
    await newerRequest
    await flush()
    expect(useJiraStore.getState().rows.one?.statusName).toBe('Newest')
  })

  it('does not create a polling timer', async () => {
    vi.useFakeTimers()
    const ipc: MockIpc = installMockIpc(createMockIpc())
    ipc.invoke.mockResolvedValue({ baseUrl: TEST_BASE_URL, email: '', patterns: [], hasToken: false })
    await useJiraStore.getState().hydrateSettings()
    useJiraStore.getState().syncProjects([{ tabId: 'one', label: 'DZ-1234' }])
    expect(vi.getTimerCount()).toBe(0)
  })
})
