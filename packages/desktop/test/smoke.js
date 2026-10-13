/**
 * Smoke test: the real Electron app against a fake server.
 *
 * Two launches share one profile directory:
 *   1. a first launch has no cookie, so the window goes base → 401 → token URL
 *      → 303 → authenticated 200;
 *   2. a second launch must reach the authenticated page with no token at all —
 *      the persistent partition kept the cookie across the restart.
 *
 * Skipped when the Electron binary is not installed.
 *
 * Run: node test/smoke.js
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStore } from '@dsh-ssh/core'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const require = createRequire(import.meta.url)

/** @type {string | undefined} */
let electronPath
try {
  electronPath = require('electron')
} catch { /* not installed */ }
if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
  const required = process.env.DSH_SSH_DESKTOP_REQUIRE_ELECTRON === '1'
  console.log(`${required ? 'FAIL' : 'skip'} smoke test (the Electron binary is not installed)`)
  process.exit(required ? 1 : 0)
}

/** Keep the renderer sandbox enabled unless the test runner explicitly opts out.
 * CI never opts out. A local restricted container must report that limitation.
 */
const extraArgs = process.env.DSH_SSH_DESKTOP_ALLOW_NO_SANDBOX === '1' ? ['--no-sandbox'] : []
if (extraArgs.length > 0) {
  console.log('note explicit test override --no-sandbox (renderer sandboxing not exercised)')
}

let failures = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.message : error}`)
  }
}

/** A free loopback port for the fake forward. */
async function freePort() {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  await new Promise((r) => server.close(r))
  return port
}

// Inside the package rather than the system temp directory: confined runners
// may let the Electron binary write only under the project.
const scratchRoot = join(appDir, '.test-tmp')
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(join(scratchRoot, 'smoke-'))
const userData = join(scratch, 'profile')
const requestLog = join(scratch, 'requests.log')
const port = await freePort()
createStore({ dir: userData }).save([
  { id: 'smoke', name: 'smoke', target: 'fake', remoteWorkspace: '/w', remotePort: port, localPort: port },
])

/**
 * Launch the app once and collect its `[smoke]` trace until it quits.
 * @returns {Promise<{ code: number | null, trace: string[], output: string }>}
 */
function launch() {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electronPath, [...extraArgs, appDir], {
      env: {
        ...env,
        DSH_SSH_DESKTOP_SMOKE: '1',
        DSH_SSH_DESKTOP_USER_DATA: userData,
        DSH_SSH_DESKTOP_TEST_TRANSPORT: join(here, 'fixtures', 'fake-dsh.js'),
        FAKE_DSH_LOG: requestLog,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      child.stderr.destroy()
      const trace = output.split(/\r?\n/).filter((l) => l.startsWith('[smoke] ')).map((l) => l.slice(8))
      resolve({ code, trace, output })
    }
    const timer = setTimeout(() => {
      output += '\nElectron smoke timed out after 60 seconds.\n'
      if (process.platform === 'win32') {
        // Include Chromium helpers; inherited output pipes can outlive the main child.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
        killer.on('error', () => { child.kill('SIGKILL') })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
      finish(null)
    }, 60_000)
    child.on('error', (error) => { output += `\n${String(error)}`; finish(null) })
    child.on('close', finish)
  })
}

const requests = () => (existsSync(requestLog) ? readFileSync(requestLog, 'utf8').trim().split(/\r?\n/) : [])

await check('first launch logs in with the launch token and lands on the UI', async () => {
  const run = await launch()
  const trace = run.trace.join('\n')
  assert.match(trace, /^ready smoke$/m, `never reached ready:\n${run.output}`)
  assert.match(trace, /^navigated 401 http:\/\/127\.0\.0\.1:\d+\/$/m, 'the clean root is tried first')
  assert.match(trace, /^load smoke token$/m)
  assert.match(trace, new RegExp(`^navigated 200 http://127\\.0\\.0\\.1:${String(port)}/$`, 'm'), 'the token redirect lands on the clean root')
  assert.equal(trace.includes('fake-launch-token'), false, 'the trace must not carry the token')
  // One window: once ready the remote view is on screen and the manager
  // dialog, which the app starts in, has closed itself.
  assert.match(trace, /^showing remote view smoke$/m)
  assert.match(trace, /^manager closed$/m)
  assert.match(trace, /^manager shows 已就绪$/m)
  // The page bridge exists on the remote page, validates its arguments, and
  // is absent from the local manager page.
  assert.match(trace, /^bridge protocol 1 notify,setBadge,revealInEditor$/m, `bridge probe:\n${trace}`)
  assert.match(trace, /^badge 2$/m)
  assert.match(trace, /^manager bridge undefined$/m)
  // The covered home page must not keep a drag strip under the remote caption:
  // Electron merges every page's drag regions, which ate clicks on "编辑".
  assert.match(trace, /^home covered$/m)
  assert.match(trace, /^home caption region no-drag$/m, `home caption:\n${trace}`)
  assert.deepEqual(requests().filter((r) => r.startsWith('GET / ') || r.startsWith('GET /?token')), ['GET / 401', 'GET /?token 303', 'GET / 200'])
  assert.equal(run.code, 0, `exit code ${String(run.code)}:\n${run.output}`)
  // The log file mirrors the connection log, redacted.
  const logFile = join(userData, 'logs', 'main.log')
  assert.ok(existsSync(logFile), 'logs/main.log is written')
  const logText = readFileSync(logFile, 'utf8')
  assert.match(logText, /\[app\] start: dsh-ssh-desktop/)
  assert.match(logText, /\[smoke\] \[ready\] ready at/)
  assert.match(logText, /\[app\] exit/)
  assert.equal(logText.includes('fake-launch-token'), false, 'no token in the log file')
})

await check('second launch reuses the persisted cookie: no token, straight to the UI', async () => {
  rmSync(requestLog, { force: true })
  const run = await launch()
  const trace = run.trace.join('\n')
  assert.equal(run.code, 0, `exit code ${String(run.code)}:\n${run.output}`)
  assert.match(trace, /^navigated 200 /m, `never loaded:\n${run.output}`)
  assert.equal(/^load smoke token$/m.test(trace), false, 'a restart must not need the token again')
  assert.deepEqual(requests().filter((r) => r.startsWith('GET / ') || r.startsWith('GET /?token')), ['GET / 200'])
})

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${String(failures)} smoke test(s) failed`)
  process.exit(1)
}
console.log('\nall smoke tests passed')
