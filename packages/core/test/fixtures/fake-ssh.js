/** A real local child for lifecycle tests; no SSH connection or credentials. */
import { createServer } from 'node:net'

const args = process.argv.slice(2)
const mode = args.at(-1)
const localCommand = args.find((arg) => arg.startsWith('LocalCommand=echo '))
const marker = localCommand?.slice('LocalCommand=echo '.length)
if (!/^DSH_FORWARD_READY_[a-f0-9]{32}$/.test(marker ?? '')) throw new Error('a per-forward acknowledgement is required')
if (mode === 'early-exit') process.exit(7)

if (mode === 'wait') {
  setInterval(() => {}, 1000)
} else {
  const forward = args[args.indexOf('-L') + 1]
  const port = Number(forward.split(':')[1])
  const server = createServer((socket) => socket.end())
  server.on('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(8)
  })
  server.listen(port, '127.0.0.1', () => {
    if (mode === 'no-ack') return
    if (mode === 'fragmented-ack') {
      // Pipes/files can expose the marker in several reads. Debug output that
      // contains it must not acknowledge readiness or leak into user logs.
      process.stdout.write(`debug3: expanded LocalCommand: echo ${marker}\n`)
      process.stdout.write(marker.slice(0, 20))
      setTimeout(() => { process.stdout.write(`${marker.slice(20)}\r\n`) }, 350)
      return
    }
    process.stdout.write(`${marker}\n`)
  })
}
