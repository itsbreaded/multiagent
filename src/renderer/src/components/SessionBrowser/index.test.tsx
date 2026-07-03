import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Session, SessionSearchResult } from '../../../../shared/types'
import { installMockIpc, type MockIpc } from '../../../../../tests/mockIpc'
import { useSessionsStore } from '../../store/sessions'
import { SessionBrowser } from './index'

let ipc: MockIpc

beforeEach(() => {
  ipc = installMockIpc()
})

afterEach(() => {
  cleanup()
})

function session(sessionId: string, overrides: Partial<Session> = {}): Session {
  return {
    agentKind: 'claude',
    sessionId,
    cwd: `C:\\projects\\${sessionId}`,
    cwdExists: true,
    projectName: `acme/${sessionId}`,
    displayName: null,
    gitBranch: null,
    firstMessage: `First message for ${sessionId}`,
    lastMessage: null,
    firstActivity: '2026-06-27T12:00:00.000Z',
    lastActivity: '2026-06-28T12:00:00.000Z',
    messageCount: 3,
    transcriptPath: `${sessionId}.jsonl`,
    status: 'resumable',
    ...overrides,
  }
}

describe('SessionBrowser - summary mode', () => {
  it('groups sessions by project and filters the summary list', async () => {
    const user = userEvent.setup()
    useSessionsStore.getState().setSessions([
      session('console', { projectName: 'acme/console', firstMessage: 'Fix terminal resize' }),
      session('server', { projectName: 'acme/server', firstMessage: 'Add API endpoint' }),
    ])
    render(<SessionBrowser />)

    expect(screen.getByText('Fix terminal resize')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'server' })).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Search sessions...'), 'terminal')

    expect(screen.getByText('Fix terminal resize')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'server' })).toBeNull()
  })
})

describe('SessionBrowser - deep mode', () => {
  it('prompts for transcript text before a deep query is entered', async () => {
    const user = userEvent.setup()
    render(<SessionBrowser />)

    await user.click(screen.getByRole('button', { name: 'Deep' }))

    expect(screen.getByText('Type to search across all transcript content.')).toBeInTheDocument()
  })

  it('debounces the IPC search and renders matching transcript snippets', async () => {
    const user = userEvent.setup()
    const matchingSession = session('console', { firstMessage: 'Investigate rendering' })
    const result: SessionSearchResult = {
      session: matchingSession,
      score: 10,
      matchCount: 1,
      matches: [{
        transcriptPath: matchingSession.transcriptPath,
        lineNumber: 12,
        timestamp: null,
        role: 'assistant',
        snippet: 'The needle appears in this transcript.',
      }],
    }
    ipc.invoke.mockResolvedValue([result])
    render(<SessionBrowser />)

    await user.click(screen.getByRole('button', { name: 'Deep' }))
    await user.type(screen.getByPlaceholderText('Search sessions...'), 'needle')

    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('sessions:search-deep', { query: 'needle' })
    })
    expect(await screen.findByText('1 match')).toBeInTheDocument()
    expect(screen.getByText('needle')).toBeInTheDocument()
    expect(screen.getByText('assistant')).toBeInTheDocument()
  })

  it('discards an in-flight deep-search response after the query is cleared (spec 036 item 5)', async () => {
    const user = userEvent.setup()
    const matchingSession = session('console', { firstMessage: 'Investigate rendering' })
    const staleResult: SessionSearchResult = {
      session: matchingSession,
      score: 10,
      matchCount: 1,
      matches: [{
        transcriptPath: matchingSession.transcriptPath,
        lineNumber: 12,
        timestamp: null,
        role: 'assistant',
        snippet: 'The needle appears in this transcript.',
      }],
    }

    // Deferred the test controls: the in-flight `needle` request stays pending
    // until we explicitly resolve it after the query has been cleared.
    let resolveSearch!: (r: SessionSearchResult[]) => void
    ipc.invoke.mockImplementation(
      () => new Promise<SessionSearchResult[]>((res) => {
        resolveSearch = res
      })
    )

    render(<SessionBrowser />)
    await user.click(screen.getByRole('button', { name: 'Deep' }))
    const input = screen.getByPlaceholderText('Search sessions...')
    await user.type(input, 'needle')

    // Request is in flight and unresolved.
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('sessions:search-deep', { query: 'needle' })
    })

    // Clear the input — the empty-query branch of runDeepSearch runs after the
    // 300ms debounce, resetting deepResults. The generation counter must bump
    // so the still-pending `needle` response is treated as stale.
    await user.clear(input)
    await waitFor(() => {
      expect(screen.getByText('Type to search across all transcript content.')).toBeInTheDocument()
    })

    // Now resolve the stale request. Pre-fix this repopulated deepResults under
    // an empty query; post-fix the stale check drops it.
    resolveSearch([staleResult])
    // Flush microtasks so the resolved promise's .then chain runs.
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.queryByText('1 match')).toBeNull()
    expect(screen.getByText('Type to search across all transcript content.')).toBeInTheDocument()
  })
})
