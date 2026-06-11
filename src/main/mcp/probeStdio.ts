import { spawn } from 'child_process'

interface JsonRpcMsg {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string }
}

export async function probeStdioServer(
  command: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 30_000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...(process.env as Record<string, string>), ...(env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Windows, commands like npx are .cmd files and require the shell
      shell: process.platform === 'win32',
      windowsHide: true,
    })

    let buf = ''
    let settled = false
    let handshakeDone = false

    const timer = setTimeout(
      () => done(() => reject(new Error('Timed out — the server may still be downloading or failed to start'))),
      timeoutMs,
    )

    function done(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      fn()
    }

    function write(msg: JsonRpcMsg): void {
      try {
        proc.stdin?.write(JSON.stringify(msg) + '\n')
      } catch { /* ignore write errors after kill */ }
    }

    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed) as JsonRpcMsg

          if (msg.id === 1 && !handshakeDone) {
            if (msg.error) {
              done(() => reject(new Error(`Initialize failed: ${msg.error?.message ?? 'unknown'}`)))
              return
            }
            handshakeDone = true
            // Complete the handshake then immediately request tool list
            write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
            write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
          } else if (msg.id === 2) {
            if (msg.error) {
              done(() => reject(new Error(`tools/list failed: ${msg.error?.message ?? 'unknown'}`)))
              return
            }
            const tools = (
              (msg.result as { tools?: Array<{ name: string }> })?.tools ?? []
            ).map((t) => t.name)
            done(() => resolve(tools))
          }
        } catch { /* skip non-JSON lines (e.g. npx download progress) */ }
      }
    })

    // Ignore stderr — some servers print startup info there
    proc.stderr?.resume()

    proc.on('error', (err) => done(() => reject(err)))
    proc.on('close', (code) => {
      done(() => reject(new Error(`Process exited (code ${code ?? '?'}) before completing the MCP handshake`)))
    })

    // Kick off MCP handshake
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'multiagent-probe', version: '1.0.0' },
      },
    })
  })
}
