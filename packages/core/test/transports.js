/**
 * The system-ssh transport's local, network-free parts: the shared option list
 * and the loopback listener probes. Carried over from the old plugin's
 * integration test, minus everything that exercised ssh2.
 *
 * Run: node test/transports.js
 */
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SystemSshTransport, baseSshArgs, probeListener, sshAvailable, sshCommand, supportsForkAfterAuthentication, waitForListener } from '../lib/transports.js'

let failures = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error && error.stack ? error.stack : error}`)
  }
}

const server = createServer((socket) => socket.end())
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const openPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port

await check('baseSshArgs renders the options every system-ssh call shares', () => {
  const args = baseSshArgs()
  // BatchMode is what stops an unattended app from hanging on a prompt.
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ConnectTimeout=15'))
  assert.ok(args.includes('ServerAliveInterval=15'))
  // Explicitly override user config, including an already-running master.
  assert.ok(args.includes('ControlPath=none'))
  assert.ok(args.includes('ControlMaster=no'))
  assert.ok(args.includes('ControlPersist=no'))
  assert.equal(args.some((a) => a.startsWith('IgnoreUnknown=')), false, 'the user may ignore Apple-only or third-party options')
  assert.equal(args.includes('-M'), false)
})

await check('background configuration compatibility includes older Apple and Windows clients', () => {
  assert.equal(supportsForkAfterAuthentication('OpenSSH_8.6p1, LibreSSL 2.8.3'), false)
  assert.equal(supportsForkAfterAuthentication('OpenSSH_8.7p1, LibreSSL 3.3.6'), true)
  assert.equal(supportsForkAfterAuthentication('OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2'), true)
  assert.equal(supportsForkAfterAuthentication('OpenSSH_10.0p2, OpenSSL 3.5'), true)
  assert.equal(supportsForkAfterAuthentication('not available'), false)
})

await check('baseSshArgs leaves identity, port and agent to ~/.ssh/config', () => {
  const args = baseSshArgs()
  for (const flag of ['-i', '-p', '-J', '-A', '-l']) assert.equal(args.includes(flag), false, flag)
})

await check('macOS always chooses Apple OpenSSH and checks that it is available', () => {
  const env = { PATH: '/opt/homebrew/bin:/usr/local/bin' }
  const executable = (path) => path === '/usr/bin/ssh'
  assert.equal(sshCommand({ platform: 'darwin', env, executable }), '/usr/bin/ssh')
  assert.equal(sshAvailable({ platform: 'darwin', env, executable }), true)
  assert.equal(sshAvailable({ platform: 'darwin', env, executable: () => false }), false)
})

await check('Windows prefers bundled OpenSSH, with a checked PATH fallback', () => {
  const env = { SystemRoot: 'D:\\Windows', PATH: 'C:\\Tools;C:\\Other' }
  const bundled = win32.join(env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe')
  const options = { platform: 'win32', env, executable: (path) => path === bundled }
  assert.equal(sshCommand(options), bundled)
  assert.equal(sshAvailable(options), true)
  options.executable = (path) => path === 'C:\\Tools\\ssh.exe'
  assert.equal(sshCommand(options), 'ssh')
  assert.equal(sshAvailable(options), true)
  options.executable = () => false
  assert.equal(sshAvailable(options), false)
})

await check('Linux resolves availability against PATH instead of assuming ssh exists', () => {
  const options = { platform: 'linux', env: { PATH: '/custom/bin:/usr/bin' }, executable: (path) => path === '/custom/bin/ssh' }
  assert.equal(sshCommand(options), 'ssh')
  assert.equal(sshAvailable(options), true)
  assert.equal(sshAvailable({ ...options, env: { PATH: '/missing' } }), false)
})

await check('the installed ssh applies lifecycle overrides before the user configuration', () => {
  if (!sshAvailable()) { console.log('skip ssh -G integration (OpenSSH is not installed)'); return }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-config-'))
  try {
    const file = join(dir, 'config')
    writeFileSync(file, [
      'Host regression',
      '  HostName example.invalid',
      '  User test-user',
      '  Port 2222',
      '  ControlMaster auto',
      '  ControlPath ~/.ssh/test-socket',
      '  ControlPersist 60',
      '  IgnoreUnknown ForkAfterAuthentication,UseKeychain',
      '  ForkAfterAuthentication yes',
      '  UseKeychain yes',
      '  IdentityAgent /tmp/test-agent',
      '',
    ].join('\n'))
    const result = spawnSync(sshCommand(), [...baseSshArgs(), '-F', file, '-G', 'regression'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^controlmaster (false|no)$/m)
    assert.match(result.stdout, /^controlpersist (no|0)$/m)
    assert.doesNotMatch(result.stdout, /^controlpath (?!none$).+/m)
    assert.doesNotMatch(result.stdout, /^forkafterauthentication yes$/m)
    assert.match(result.stdout, /^hostname example\.invalid$/m)
    assert.match(result.stdout, /^user test-user$/m)
    assert.match(result.stdout, /^port 2222$/m)
    assert.match(result.stdout, /^identityagent \/tmp\/test-agent$/m)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('a listening loopback port is reported as such, a closed one is not', async () => {
  assert.equal(await probeListener(openPort), true)
  assert.equal(await probeListener(1), false)
})

await check('waitForListener resolves false instead of hanging on a dead port', async () => {
  const started = Date.now()
  const ok = await waitForListener(1, 600)
  assert.equal(ok, false)
  assert.ok(Date.now() - started < 5_000)
})

await check('dispose without a forward is harmless and idempotent', () => {
  const transport = new SystemSshTransport(/** @type {any} */ ({ target: 'devbox' }))
  transport.dispose()
  transport.dispose()
  assert.equal(transport.forward, null)
})

/** An available loopback port, without assuming a machine's service layout. */
async function freePort() {
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

const fixture = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url))
function testTransport(mode = 'ready') {
  const children = []
  const transport = new SystemSshTransport(/** @type {any} */ ({ target: mode }), {
    readyTimeoutMs: 2_000,
    spawn: (_command, args, options) => {
      const child = spawn(process.execPath, [fixture, ...args], options)
      children.push(child)
      return child
    },
  })
  const drops = []
  transport.onDrop = (error) => drops.push(error)
  return { transport, children, drops }
}

async function until(predicate) {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for child state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

await check('an occupied local port is refused before an ssh child is spawned', async () => {
  const { transport, children } = testTransport()
  try {
    await assert.rejects(transport.startTunnel(openPort, openPort), /already in use/)
    assert.equal(children.length, 0)
    assert.equal(transport.forward, null)
  } finally { transport.dispose() }
})

await check('an asynchronous spawn error rejects the forward without crashing the process', async () => {
  const port = await freePort()
  const transport = new SystemSshTransport(/** @type {any} */ ({ target: 'unused' }), {
    spawn: (_command, _args, options) => spawn(join(tmpdir(), 'dsh-ssh-nonexistent-executable'), [], options),
    readyTimeoutMs: 1_000,
  })
  try {
    await assert.rejects(transport.startTunnel(port, port), /ENOENT/)
    assert.equal(transport.forward, null)
  } finally { transport.dispose() }
})

await check('a child that exits before listening fails startup promptly', async () => {
  const { transport, children, drops } = testTransport('early-exit')
  const port = await freePort()
  try {
    await assert.rejects(transport.startTunnel(port, port), /code 7/)
    assert.equal(transport.forward, null)
    assert.equal(children[0].exitCode, 7)
    assert.equal(drops.length, 0, 'startup failures are returned, not also reported as drops')
  } finally { transport.dispose() }
})

await check('a signal during startup rejects before readiness and emits no drop', async () => {
  const { transport, children, drops } = testTransport('wait')
  const port = await freePort()
  try {
    const pending = transport.startTunnel(port, port)
    const rejected = assert.rejects(pending, /ssh forward exited/)
    await until(() => children.length === 1)
    children[0].kill('SIGTERM')
    await rejected
    assert.equal(transport.forward, null)
    assert.equal(drops.length, 0)
  } finally { transport.dispose() }
})

await check('a signal exit after readiness reports one drop and cleans its log and state', async () => {
  const { transport, children, drops } = testTransport()
  const port = await freePort()
  try {
    await transport.startTunnel(port, port)
    assert.equal(transport.forward.active, 1)
    const log = transport.forwarderLog.file
    children[0].kill('SIGTERM')
    await until(() => drops.length === 1)
    assert.equal(transport.forward, null)
    assert.equal(existsSync(log), false)
    assert.match(drops[0].message, /ssh forward exited/)
    if (process.platform !== 'win32') assert.match(drops[0].message, /signal SIGTERM/)
    assert.equal(await probeListener(port), false)
  } finally { transport.dispose() }
})

await check('dispose while startup is pending cancels it without a drop or leaked child', async () => {
  const { transport, children, drops } = testTransport('wait')
  const port = await freePort()
  try {
    const pending = transport.startTunnel(port, port)
    const rejected = assert.rejects(pending, /cancelled/)
    await until(() => children.length === 1)
    const log = transport.forwarderLog.file
    transport.dispose()
    await rejected
    await until(() => children[0].exitCode !== null || children[0].signalCode !== null)
    assert.equal(transport.forward, null)
    assert.equal(existsSync(log), false)
    assert.equal(drops.length, 0)
  } finally { transport.dispose() }
})

await check('dispose before the port precheck finishes never starts a child', async () => {
  const { transport, children } = testTransport()
  const port = await freePort()
  const pending = transport.startTunnel(port, port)
  transport.dispose()
  await assert.rejects(pending, /cancelled/)
  assert.equal(children.length, 0)
})

await check('a replaced startup cannot clear or announce readiness for the new forward', async () => {
  const { transport, children, drops } = testTransport('wait')
  const firstPort = await freePort()
  const nextPort = await freePort()
  try {
    const first = transport.startTunnel(firstPort, firstPort)
    const rejected = assert.rejects(first, /cancelled/)
    await until(() => children.length === 1)
    transport.config.target = 'ready'
    const result = await transport.startTunnel(nextPort, nextPort)
    await rejected
    assert.equal(result.localPort, nextPort)
    assert.equal(transport.forward.localPort, nextPort)
    assert.equal(transport.forward.active, 1)
    assert.equal(drops.length, 0)
  } finally { transport.dispose() }
})

await check('disposing a ready forward frees the listener without reporting a drop', async () => {
  const { transport, children, drops } = testTransport()
  const port = await freePort()
  try {
    await transport.startTunnel(port, port)
    const log = transport.forwarderLog.file
    transport.dispose()
    await until(() => children[0].exitCode !== null || children[0].signalCode !== null)
    assert.equal(transport.forward, null)
    assert.equal(await probeListener(port), false)
    assert.equal(existsSync(log), false)
    assert.equal(drops.length, 0)
  } finally { transport.dispose() }
})

server.close()

if (failures > 0) {
  console.error(`\n${String(failures)} transport test(s) failed`)
  process.exit(1)
}
console.log('\nall transport tests passed')
