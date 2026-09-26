import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installMockIpc } from '../../../../../../tests/mockIpc'
import { useJiraStore } from '../../../store/jira'
import { JiraSetting } from './JiraSetting'

const TEST_BASE_URL = 'https://jira.example.com'

beforeEach(() => {
  useJiraStore.setState({
    settings: { baseUrl: TEST_BASE_URL, email: '', patterns: [], hasToken: false },
    hydrated: true,
    configVersion: 0,
    labels: {},
    projects: {},
    rows: {},
    suppressedInitialTabs: {},
  })
})

afterEach(() => cleanup())

describe('JiraSetting', () => {
  it('uses a normal password field with show/hide and clear actions', async () => {
    const ipc = installMockIpc()
    useJiraStore.setState({
      settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true },
    })
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira:get-token') return { ok: true, token: 'saved-token' }
      return {
        ok: true,
        settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: false },
      }
    })

    const { unmount } = render(<JiraSetting />)
    const tokenInput = screen.getByLabelText('Jira API token')
    await waitFor(() => expect(tokenInput).toHaveValue('saved-token'))
    expect(tokenInput).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getByRole('button', { name: 'Show Jira API token' }))
    expect(tokenInput).toHaveAttribute('type', 'text')
    expect(tokenInput).toHaveValue('saved-token')
    fireEvent.click(screen.getByRole('button', { name: 'Hide Jira API token' }))
    expect(tokenInput).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Clear saved token' }))
    expect(tokenInput).toHaveValue('')
    expect(tokenInput).not.toBeDisabled()
    unmount()

    expect(ipc.invoke).toHaveBeenCalledWith('jira:save-settings', expect.objectContaining({ clearToken: true }))
  })

  it('saves a newly entered token and editable fields and prefixes when settings close', () => {
    const ipc = installMockIpc()
    ipc.invoke.mockResolvedValue({
      ok: true,
      settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true },
    })
    const { unmount } = render(<JiraSetting />)
    fireEvent.change(screen.getByLabelText('Atlassian account email'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('Jira API token'), { target: { value: 'secret-token' } })
    fireEvent.change(screen.getByLabelText('Jira issue-key prefix 1'), { target: { value: 'DZ-' } })
    unmount()

    expect(ipc.invoke).toHaveBeenCalledWith('jira:save-settings', expect.objectContaining({
      email: 'user@example.com',
      apiToken: 'secret-token',
      patterns: ['DZ-'],
    }))
  })

  it('saves a replaced token when settings close', async () => {
    const ipc = installMockIpc()
    useJiraStore.setState({
      settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true },
    })
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira:get-token') return { ok: true, token: 'old-token' }
      return {
        ok: true,
        settings: { baseUrl: TEST_BASE_URL, email: 'user@example.com', patterns: ['DZ-'], hasToken: true },
      }
    })

    const { unmount } = render(<JiraSetting />)
    const tokenInput = screen.getByLabelText('Jira API token')
    await waitFor(() => expect(tokenInput).toHaveValue('old-token'))
    fireEvent.change(tokenInput, { target: { value: 'new-token' } })
    unmount()

    expect(ipc.invoke).toHaveBeenCalledWith('jira:save-settings', expect.objectContaining({ apiToken: 'new-token' }))
  })

  it('tests the current connection without saving and reports safe errors', async () => {
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira:test-connection') return { ok: false, error: 'Jira authentication was rejected.' }
      return undefined
    })
    render(<JiraSetting />)
    fireEvent.change(screen.getByLabelText('Jira API token'), { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test Jira connection' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('authentication was rejected')
    expect(ipc.invoke).toHaveBeenCalledWith('jira:test-connection', expect.objectContaining({ apiToken: 'secret-token' }))
    expect(ipc.invoke).not.toHaveBeenCalledWith('jira:save-settings', expect.anything())
    expect(screen.queryByText('secret-token')).not.toBeInTheDocument()
  })

  it('reports a successful connection test', async () => {
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira:test-connection') return { ok: true, message: 'Jira connection succeeded.' }
      return undefined
    })
    render(<JiraSetting />)
    fireEvent.change(screen.getByLabelText('Jira API token'), { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test Jira connection' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Jira connection succeeded.')
  })
})
