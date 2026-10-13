/** Launch Electron as a GUI even when the calling terminal belongs to Electron. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

try {
  const electron = require('electron')
  const child = spawn(electron, [desktop, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false })
  let closed = false
  child.on('error', (error) => {
    console.error(`Could not launch Electron: ${error.message}`)
    process.exitCode = 1
  })
  child.on('close', (code, signal) => {
    closed = true
    if (signal) console.error(`Electron exited with signal ${signal}`)
    process.exitCode = code ?? 1
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { if (!closed) child.kill(signal) })
  }
} catch (error) {
  console.error(`Could not find Electron. Run pnpm install first. ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
