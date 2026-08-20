import { readFileSync } from 'fs'
import { join } from 'path'
import vm from 'vm'
import { describe, expect, it } from 'vitest'

function loadPlugin(posts: Array<{ path: string; body: Record<string, unknown> }>) {
  const source = readFileSync(join(process.cwd(), 'src/main/integration/assets/multiagent-opencode-plugin.js'), 'utf8')
    .replace('export const MultiAgentPlugin =', 'globalThis.MultiAgentPlugin =')
  const context = {
    process: { env: { MULTIAGENT_ENV: '1', MULTIAGENT_PTY_ID: 'pty-opencode', MULTIAGENT_HOOK_PORT: '43123' } },
    fetch: (url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as Record<string, unknown>
      posts.push({ path: new URL(url).pathname, body: parsed })
      return Promise.resolve({})
    },
    AbortController,
    setTimeout,
    clearTimeout,
    Map,
    Set,
    JSON,
    URL,
    console,
  }
  vm.runInNewContext(source, context)
  return (context as typeof context & { MultiAgentPlugin: () => Promise<Record<string, any>> }).MultiAgentPlugin
}

describe('managed OpenCode plugin status adapter', () => {
  it('uses current session status shapes and keeps root-only idle incomplete', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const plugin = await loadPlugin(posts)()
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'root-1' } } } })
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'root-1', status: { type: 'busy' } } } })
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'root-1', status: { type: 'idle' } } } })
    const statuses = posts.filter((post) => post.path === '/agent-event')
    expect(statuses.map((post) => post.body.event)).toEqual(['session_start', 'user_prompt_submit', 'work_snapshot', 'work_snapshot'])
    expect((statuses.at(-1)?.body.evidence as Record<string, unknown>).completeness).toBe('incomplete')
    expect(statuses.at(-1)?.body.event).not.toBe('stop')
  })

  it('attributes a busy child protectively without allowing child idle to stop the root', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const plugin = await loadPlugin(posts)()
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'root-1' } } } })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'child-1', parentID: 'root-1' } } } })
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'child-1', status: { type: 'busy' } } } })
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'child-1', status: { type: 'idle' } } } })
    const childReports = posts.filter((post) => post.path === '/agent-event').slice(1)
    expect(childReports[0].body.sessionId).toBe('root-1')
    const busySnapshot = childReports.find((post) => post.body.event === 'work_snapshot')
    expect((busySnapshot?.body.evidence as Record<string, unknown>).activeCount).toBe(1)
    expect(childReports.at(-1)?.body.event).toBe('work_snapshot')
  })

  it('does not accept guessed execution event names', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const plugin = await loadPlugin(posts)()
    await plugin.event({ event: { type: 'session.execution.succeeded', properties: { sessionID: 'root-1' } } })
    expect(posts).toHaveLength(0)
  })

  it('keeps a child-before-parent status unresolved until the parent relationship is known', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const plugin = await loadPlugin(posts)()
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'root-1' } } } })
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'child-1', status: { type: 'busy' } } } })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'child-1', parentID: 'root-1' } } } })
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'root-1', status: { type: 'idle' } } } })
    const snapshot = posts.filter((post) => post.body.event === 'work_snapshot').at(-1)
    expect(snapshot?.body.sessionId).toBe('root-1')
    expect((snapshot?.body.evidence as Record<string, unknown>).activeCount).toBe(1)
    expect((snapshot?.body.evidence as Record<string, unknown>).completeness).toBe('incomplete')
  })

  it('establishes a turn before reporting an initial retry status', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const plugin = await loadPlugin(posts)()
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'root-1' } } } })
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'root-1', status: { type: 'retry', message: 'retrying' } } } })
    const statuses = posts.filter((post) => post.path === '/agent-event')
    expect(statuses.map((post) => post.body.event)).toEqual(['session_start', 'user_prompt_submit', 'work_snapshot'])
    expect((statuses.at(-1)?.body.evidence as Record<string, unknown>).terminalState).toBe('retry')
    expect((statuses.at(-1)?.body.evidence as Record<string, unknown>).activeCount).toBe(1)
  })
})
