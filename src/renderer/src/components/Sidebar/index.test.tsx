import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeLeaf } from '../../../../shared/paneTree'
import { installMockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { useJiraStore } from '../../store/jira'
import { Sidebar } from './index'

const TEST_BASE_URL = 'https://jira.example.com'

beforeEach(() => {
  usePanesStore.setState({
    sidebarOpen: true,
    sidebarWidth: 260,
    sidebarPanelSizes: {},
    tabs: [{ id: 'jira-tab', customLabel: 'DZ-1234', rootNode: makeLeaf('C:\\work'), focusedPaneId: 'pane-1' }],
    activeTabId: 'jira-tab',
    sidebarSectionOpen: {},
  })
  useJiraStore.setState({
    settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true },
    hydrated: true,
    configVersion: 0,
    labels: { 'jira-tab': 'DZ-1234' },
    projects: { 'jira-tab': { tabId: 'jira-tab', label: 'DZ-1234', issueKey: 'DZ-1234', prefix: 'DZ-' } },
    rows: {},
    suppressedInitialTabs: {},
  })
})

afterEach(() => cleanup())

describe('Sidebar Jira controls', () => {
  it('offers the bulk refresh action for detected Jira folders', () => {
    const ipc = installMockIpc()
    ipc.invoke.mockResolvedValue({ ok: false, issueKey: 'DZ-1234', code: 'network', message: 'Jira could not be reached.' })
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh all Jira statuses' }))
    expect(ipc.invoke).toHaveBeenCalledWith('jira:fetch-status', 'DZ-1234')
  })
})
