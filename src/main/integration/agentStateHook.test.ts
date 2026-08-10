import { describe, it, expect } from 'vitest'
import * as http from 'http'
import { spawn } from 'child_process'
import * as path from 'path'

// Spec 065: offline hook contract tests. These feed canned JSON directly to the host
// hook asset and capture localhost POSTs. They never launch Claude or a real subagent.

interface CapturedEvent {
  ptyId?: string
  agentKind?: string
  event?: string
  detail?: string
  turnId?: string
  agentId?: string
}

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

async function runHook(event: string, payload: unknown): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = []
  const capture = await startCapture(events)
  const script = path.resolve(__dirname, 'assets', process.platform === 'win32'
    ? 'multiagent-agent-state.ps1'
    : 'multiagent-agent-state.sh')
  const command = process.platform === 'win32' ? 'powershell.exe' : 'bash'
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'claude', event]
    : [script, 'claude', event]
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
      }, 10_000)
      child.on('error', reject)
      child.on('exit', (value) => {
        clearTimeout(timer)
        resolve(value ?? -1)
      })
      child.stdin.end(JSON.stringify(payload))
    })
    expect(code).toBe(0)
    return events
  } finally {
    await new Promise<void>((resolve) => capture.server.close(() => resolve()))
  }
}

describe('managed agent-state hook payload contract (spec 065)', () => {
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
})
