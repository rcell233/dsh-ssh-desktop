/** A real local child for lifecycle tests; no SSH connection or credentials. */
import { createServer } from 'node:net'

const args = process.argv.slice(2)
const mode = args.at(-1)
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
  server.listen(port, '127.0.0.1')
}
