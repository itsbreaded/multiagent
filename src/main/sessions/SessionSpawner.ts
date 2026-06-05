import type { PtyManager } from '../pty/PtyManager'

export class SessionSpawner {
  constructor(private ptyManager: PtyManager) {}

  async spawnNew(cwd: string): Promise<{ ptyId: string; sessionId: string | null }> {
    const ptyId = this.ptyManager.createClaude(cwd)
    this._writeWhenPromptReady(ptyId, 'claude\r')
    return { ptyId, sessionId: null }
  }

  async spawnResume(sessionId: string, cwd: string): Promise<{ ptyId: string }> {
    const ptyId = this.ptyManager.createClaude(cwd)
    this._writeWhenPromptReady(ptyId, `claude --resume ${sessionId}\r`)
    return { ptyId }
  }

  // Wait until the shell has printed its prompt (detected by 'PS ' or '$ ' or '> '
  // in the PTY output) before sending the command. This is more reliable than any
  // fixed timeout because startup time varies by machine and PowerShell version.
  private _writeWhenPromptReady(ptyId: string, command: string): void {
    let sent = false
    let outputBuffer = ''
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null

    const send = () => {
      if (sent) return
      sent = true
      if (fallbackTimer) clearTimeout(fallbackTimer)
      this.ptyManager.write(ptyId, command)
    }

    const isPromptReady = (text: string): boolean => {
      // PowerShell: "PS C:\...>"
      if (text.includes('PS ') && text.includes('>')) return true
      // cmd.exe: "C:\...>"
      if (/[A-Z]:\\.*>/.test(text)) return true
      // bash/zsh: ends with $ or %
      if (/[$%]\s*$/.test(text)) return true
      return false
    }

    const onReady = (readyId: string) => {
      if (readyId !== ptyId) return
      this.ptyManager.off('ready', onReady)

      const onData = (dataId: string, data: string) => {
        if (dataId !== ptyId) return
        outputBuffer += data

        if (isPromptReady(outputBuffer)) {
          this.ptyManager.off('data', onData)
          // Small pause so the shell finishes drawing the prompt line
          setTimeout(send, 150)
        }
      }

      this.ptyManager.on('data', onData)

      // Fallback: send after 10s even if we never detect the prompt
      fallbackTimer = setTimeout(() => {
        this.ptyManager.off('data', onData)
        send()
      }, 10_000)
    }

    this.ptyManager.on('ready', onReady)
  }
}
