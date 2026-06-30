const intervalMs = Math.max(1, Number(process.env.MULTIAGENT_E2E_FRAME_INTERVAL_MS || 2))
let sequence = 0

function emitFrame(kind = 'FRAME') {
  sequence += 1
  process.stdout.write(`\x1b]777;${kind}:${String(sequence).padStart(8, '0')}\x07`)
}

process.stdin.resume()

process.stdout.on('resize', () => {
  for (let i = 0; i < 8; i += 1) emitFrame('RESIZE')
})

process.stdout.write(`__multiagent_framed_agent_pid__:${process.pid}\r\n`)
const timer = setInterval(emitFrame, intervalMs)
timer.unref()
setInterval(() => {}, 30_000)
