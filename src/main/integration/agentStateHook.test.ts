import { describe, it, expect } from 'vitest'
import * as http from 'http'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import * as path from 'path'
import { AgentSessionReportServer, type AgentEventReport } from './agentSessionReportServer'
import { eventToState } from '../../shared/agentStatus'
import type { AgentStatusState, AgentWorkSnapshot } from '../../shared/types'

// Spec 065: offline hook contract tests. These feed canned JSON directly to the host
// hook asset and capture localhost POSTs. They never launch Claude or a real subagent.

interface CapturedEvent {
  ptyId?: string
  agentKind?: string
  event?: string
  detail?: string
  turnId?: string
  agentId?: string
  sessionId?: string
  evidence?: AgentWorkSnapshot
}

// Windows PowerShell startup is slow enough on hosted runners to exceed the
// local 10-second fixture budget. Keep the timeout tight on Unix while allowing
// the Windows child process time to start and post its event.
const HOOK_FIXTURE_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 10_000
const UNIX_BASH_COMMAND = process.platform === 'win32'
  ? (existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : undefined)
  : 'bash'

function startCapture(events: CapturedEvent[]): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        if (req.url === '/agent-event' && req.method === 'POST') {
          try { events.push(JSON.parse(body) as CapturedEvent) } catch { /* assertion sees no event */ }
          res.writeHead(204); res.end()
          return
        }
        res.writeHead(404); res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 })
    })
  })
}

async function runHook(event: string, payload: unknown, raw = false, agentKind = 'claude', platform: 'host' | 'unix' = 'host'): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = []
  const capture = await startCapture(events)
  const useUnix = platform === 'unix' || (platform === 'host' && process.platform !== 'win32')
  const script = path.resolve(__dirname, 'assets', useUnix
    ? 'multiagent-agent-state.sh'
    : 'multiagent-agent-state.ps1')
  const command = useUnix ? UNIX_BASH_COMMAND : 'powershell.exe'
  if (!command) {
    capture.server.close()
    throw new Error('Unix hook fixture requires bash or Git Bash')
  }
  const args = useUnix
    ? [script, agentKind, event]
    : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, agentKind, event]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MULTIAGENT_ENV: '1',
    MULTIAGENT_PTY_ID: 'hook-test-pty',
    MULTIAGENT_HOOK_PORT: String(capture.port),
  }
  delete env.MULTIAGENT_SESSION_ID

  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { cwd: path.resolve(__dirname, '../../..'), env, windowsHide: true })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('hook fixture timed out'))
      }, HOOK_FIXTURE_TIMEOUT_MS)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (value) => {
        clearTimeout(timer)
        resolve(value ?? -1)
      })
      child.stdin.end(raw ? String(payload) : JSON.stringify(payload))
    })
    expect(code).toBe(0)
    return events
  } finally {
    await new Promise<void>((resolve) => capture.server.close(() => resolve()))
  }
}

describe('managed agent-state hook payload contract (spec 065)', { timeout: 60_000 }, () => {
  it('reports async_launched Agent launches with their identity', async () => {
    const events = await runHook('post_tool_use', {
      tool_name: 'Agent',
      tool_response: { status: 'async_launched', agentId: 'sub-1' },
      tool_input: { run_in_background: true },
      prompt_id: 'turn-1',
    })
    expect(events).toEqual([{
      ptyId: 'hook-test-pty',
      agentKind: 'claude',
      event: 'bg_subagent_started',
      detail: 'Agent',
      turnId: 'turn-1',
      agentId: 'sub-1',
    }])
  })

  it('reports run_in_background launches even without async_launched', async () => {
    const events = await runHook('post_tool_use', {
      tool_name: 'Task',
      tool_response: { status: 'completed', agentId: 'sub-2' },
      tool_input: { run_in_background: true },
      prompt_id: 'turn-2',
    })
    expect(events[0]).toMatchObject({ event: 'bg_subagent_started', agentId: 'sub-2', detail: 'Task' })
  })

  it('keeps ordinary tools on the existing post_tool_use event', async () => {
    const events = await runHook('post_tool_use', {
      tool_name: 'Bash',
      tool_response: { status: 'completed' },
      tool_input: {},
      prompt_id: 'turn-3',
    })
    expect(events[0]).toMatchObject({ event: 'post_tool_use', detail: 'Bash', turnId: 'turn-3' })
    expect(events[0].agentId).toBeUndefined()
  })

  it('reports SubagentStop agent_id as the completion identity', async () => {
    const events = await runHook('bg_subagent_completed', {
      agent_id: 'sub-1',
      prompt_id: 'turn-1',
    })
    expect(events[0]).toMatchObject({
      event: 'bg_subagent_completed',
      turnId: 'turn-1',
      agentId: 'sub-1',
    })
  })

  it('reports Claude agent_completed notifications as background completion events', async () => {
    const platforms = UNIX_BASH_COMMAND ? (['host', 'unix'] as const) : (['host'] as const)
    for (const platform of platforms) {
      const events = await runHook('bg_agent_completed', {
        notification_type: 'agent_completed', session_id: 'session-1',
      }, false, 'claude', platform)
      expect(events).toEqual([{
        ptyId: 'hook-test-pty', agentKind: 'claude', event: 'bg_agent_completed',
        sessionId: 'session-1',
      }])
    }
  })

  it('does not treat another notification type as agent completion', async () => {
    const platforms = UNIX_BASH_COMMAND ? (['host', 'unix'] as const) : (['host'] as const)
    for (const platform of platforms) {
      const events = await runHook('bg_agent_completed', {
        notification_type: 'idle_prompt', session_id: 'session-1', prompt_id: 'turn-1',
      }, false, 'claude', platform)
      expect(events).toEqual([])
    }
  })

  it('reports complete empty Claude task and cron evidence only for top-level empty arrays', async () => {
    const events = await runHook('stop', {
      session_id: 'session-1',
      prompt_id: 'turn-1',
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    })
    expect(events[0]).toMatchObject({
      event: 'stop', sessionId: 'session-1',
      evidence: {
        provider: 'claude', completeness: 'complete', activeCount: 0, scheduledCount: 0,
        sessionId: 'session-1', turnId: 'turn-1',
      },
    })

    const malformed = await runHook('stop', {
      session_id: 'session-1',
      prompt_id: 'turn-1',
      metadata: { background_tasks: [], session_crons: [] },
    })
    expect(malformed[0].evidence).toMatchObject({ completeness: 'incomplete', activeCount: 0, scheduledCount: 0 })
    const truncated = await runHook('stop', '{"session_id":"session-1","background_tasks":[],"session_crons":[]', true)
    expect(truncated[0].evidence).toMatchObject({ completeness: 'incomplete', activeCount: 0, scheduledCount: 0 })
  })

  it('does not keep a completed background task active when its result is linked in the conversation', async () => {
    const payload = {
      session_id: 'session-1',
      prompt_id: 'turn-1',
      agent_id: 'sub-1',
      background_tasks: [{
        id: 'task-1',
        type: 'subagent',
        status: 'completed',
        description: 'linked artifact with an embedded "status":"running" example',
      }],
      session_crons: [],
    }
    const platforms = UNIX_BASH_COMMAND ? (['host', 'unix'] as const) : (['host'] as const)
    for (const platform of platforms) {
      const events = await runHook('bg_subagent_completed', payload, false, 'claude', platform)
      expect(events[0]).toMatchObject({
        event: 'bg_subagent_completed', agentId: 'sub-1',
        evidence: {
          provider: 'claude', completeness: 'complete', activeCount: 0, scheduledCount: 0,
          sessionId: 'session-1', turnId: 'turn-1',
        },
      })
    }
  })

  it('preserves positively observed work counts when the other Claude list is missing', async () => {
    const events = await runHook('stop', {
      session_id: 'session-1',
      prompt_id: 'turn-1',
      stop_hook_active: false,
      background_tasks: [{ id: 'sub-1' }],
    })
    expect(events[0].evidence).toMatchObject({
      completeness: 'incomplete', activeCount: 1, scheduledCount: 0,
      sessionId: 'session-1', turnId: 'turn-1',
    })
  })

  it('reports a Codex stop with lifecycle identity but no fabricated work evidence', async () => {
    const events = await runHook('stop', { session_id: 'session-1', turn_id: 'turn-1' }, false, 'codex')
    expect(events).toEqual([{
      ptyId: 'hook-test-pty', agentKind: 'codex', event: 'stop',
      turnId: 'turn-1', sessionId: 'session-1',
    }])
  })

  it('reports Claude idle_prompt with session and current turn identity', async () => {
    const events = await runHook('idle_prompt', { notification_type: 'idle_prompt', session_id: 'session-1', prompt_id: 'turn-1', message: 'ignored' })
    expect(events).toEqual([{ ptyId: 'hook-test-pty', agentKind: 'claude', event: 'idle_prompt', turnId: 'turn-1', sessionId: 'session-1' }])
    expect(await runHook('idle_prompt', { notification_type: 'agent_completed', session_id: 'session-1' })).toEqual([])
  })

  it('keeps Stop busy when stop_hook_active is true, missing, or malformed', async () => {
    for (const stop_hook_active of [true, undefined, 'false']) {
      const payload = { session_id: 'session-1', prompt_id: 'turn-1', background_tasks: [], session_crons: [], ...(stop_hook_active === undefined ? {} : { stop_hook_active }) }
      const events = await runHook('stop', payload)
      expect(events[0].evidence).toMatchObject({ terminalState: 'busy' })
    }
  })

  it('prefers current StopFailure error fields and bounds verbose details', async () => {
    const current = await runHook('stop_failure', { session_id: 'session-1', prompt_id: 'turn-1', error: 'api_error', error_details: 'ignored details' })
    expect(current[0]).toMatchObject({ event: 'stop_failure', detail: 'api_error' })
    const verbose = 'x'.repeat(400)
    const bounded = await runHook('stop_failure', { session_id: 'session-1', prompt_id: 'turn-1', error_details: verbose })
    expect(bounded[0].detail).toHaveLength(256)
  })

  it.skipIf(!UNIX_BASH_COMMAND)('keeps the Unix hook asset in parity for idle recovery and Stop continuation', async () => {
    const idle = await runHook('idle_prompt', {
      notification_type: 'idle_prompt', session_id: 'session-1', prompt_id: 'turn-1',
    }, false, 'claude', 'unix')
    expect(idle[0]).toMatchObject({ event: 'idle_prompt', sessionId: 'session-1', turnId: 'turn-1' })
    const continuing = await runHook('stop', {
      session_id: 'session-1', prompt_id: 'turn-1', stop_hook_active: true,
      background_tasks: [], session_crons: [],
    }, false, 'claude', 'unix')
    expect(continuing[0].evidence).toMatchObject({ terminalState: 'busy', sessionId: 'session-1', turnId: 'turn-1' })
  })

  it('composes the Claude hook process, report server, renderer listener shape, and reducer', async () => {
    let state: AgentStatusState = {
      status: 'working', sessionId: 'session-1', turnId: 'turn-1', event: 'user_prompt_submit', updatedAt: 1,
    }
    const rendererListener = (report: AgentEventReport): void => {
      state = eventToState(state, {
        event: report.event,
        agentKind: report.agentKind,
        detail: report.detail,
        sessionId: report.sessionId,
        turnId: report.turnId,
        agentId: report.agentId,
        evidence: report.evidence,
      }, 2)!
    }
    const server = new AgentSessionReportServer({ onReport: () => {}, onEvent: rendererListener })
    server.start()
    const port = await server.ready()
    const useUnix = process.platform !== 'win32'
    const script = path.resolve(__dirname, 'assets', useUnix
      ? 'multiagent-agent-state.sh'
      : 'multiagent-agent-state.ps1')
    const command = useUnix ? UNIX_BASH_COMMAND : 'powershell.exe'
    if (!command) {
      server.stop()
      throw new Error('Unix hook fixture requires bash or Git Bash')
    }
    const args = useUnix
      ? [script, 'claude', 'idle_prompt']
      : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'claude', 'idle_prompt']
    const child = spawn(command, args, {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, MULTIAGENT_ENV: '1', MULTIAGENT_PTY_ID: 'hook-compose', MULTIAGENT_HOOK_PORT: String(port) },
      windowsHide: true,
    })
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('composed hook fixture timed out')) }, 30_000)
        child.once('error', (error) => { clearTimeout(timer); reject(error) })
        child.once('close', (code) => { clearTimeout(timer); resolve(code ?? -1) })
        child.stdin.end(JSON.stringify({ notification_type: 'idle_prompt', session_id: 'session-1', prompt_id: 'turn-1' }))
      })
      expect(exitCode).toBe(0)
      expect(state).toMatchObject({ status: 'idle', event: 'idle_prompt', sessionId: 'session-1', turnId: 'turn-1', suspensionBlocked: true })
    } finally {
      server.stop()
    }
  }, 60_000)

  it('lets idle_prompt clear incomplete unknown Stop evidence without authorizing suspension', async () => {
    const platforms = UNIX_BASH_COMMAND ? (['host', 'unix'] as const) : (['host'] as const)
    for (const platform of platforms) {
      let state: AgentStatusState = {
        status: 'working', sessionId: 'session-1', turnId: 'turn-1', event: 'user_prompt_submit', updatedAt: 1,
      }
      const stop = await runHook('stop', {
        session_id: 'session-1', prompt_id: 'turn-1', stop_hook_active: false,
      }, false, 'claude', platform)
      state = eventToState(state, {
        event: stop[0].event as 'stop', agentKind: 'claude', sessionId: stop[0].sessionId,
        turnId: stop[0].turnId, evidence: stop[0].evidence,
      }, 2)!
      expect(state).toMatchObject({ status: 'idle', event: 'stop', suspensionBlocked: true })
      expect(state.activeWorkCount).toBeUndefined()
      expect(state.scheduledWorkCount).toBeUndefined()

      state = eventToState(state, {
        event: 'idle_prompt', agentKind: 'claude', sessionId: 'session-1', turnId: 'turn-1',
      }, 3)!
      expect(state).toMatchObject({ status: 'idle', event: 'stop', suspensionBlocked: true })

      state = eventToState(state, {
        event: 'user_prompt_submit', agentKind: 'claude', sessionId: 'session-1', turnId: 'turn-2',
      }, 4)!
      expect(state).toMatchObject({ status: 'working', event: 'user_prompt_submit', turnId: 'turn-2' })
      expect(state.activeWorkCount).toBeUndefined()
      expect(state.scheduledWorkCount).toBeUndefined()
    }
  }, 60_000)
})
