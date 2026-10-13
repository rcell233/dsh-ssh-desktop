/**
 * The start script: its shape, and — when a POSIX `sh` is available locally —
 * its behaviour, by actually running it against a fake `dsh`.
 *
 * The behaviour half matters because the link secret takes a deliberately
 * indirect route (stdin → `read` → 0600 file → wrapper → harness environment)
 * so that it never appears in any command line. Asserting the text alone could
 * not show that the harness really ends up holding it.
 *
 * Run: node test/start-script.js
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalize } from '../lib/config.js'
import { LINK_SECRET_ENV, readLinkSecret, startCommand } from '../lib/remote.js'

const SECRET = 'c0ffee'.repeat(10) + 'abcd'

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

const config = normalize({ target: 'devbox', remoteWorkspace: '/srv/work', remoteProfile: 'web', remotePort: 3080 })

await check('the start script is well formed', () => {
  const { script } = startCommand(config, '/usr/bin/dsh')
  // Balanced quoting is the thing that silently breaks a remote shell.
  const singleQuotes = (script.match(/'/g) ?? []).length
  assert.equal(singleQuotes % 2, 0, 'unbalanced single quotes in the start script')
  assert.match(script, /systemd-run --user --collect --unit=/)
  assert.match(script, /StandardOutput=file:/, 'the log must be a file: journald is often unreadable')
  assert.equal(script.includes('append:'), false, 'append: needs systemd 240; RHEL 8 ships 239')
  assert.equal(script.includes('script -qfc'), false, 'the pty wrapper broke port binding and must not be used')
  assert.match(script, /printf "STARTED=/)
  // It must refuse an absent workspace rather than starting in the wrong directory.
  assert.match(script, /workspace directory does not exist/)
})

await check('with a secret, the script reads it from stdin and never contains it', () => {
  const { script, input } = startCommand(config, '/usr/bin/dsh', { secret: SECRET })
  assert.equal(input, `${SECRET}\n`)
  assert.equal(script.includes(SECRET), false, 'the secret must not be in the command text')
  assert.equal(script.includes('--setenv'), false, 'systemd-run argv is visible to every user')
  assert.match(script, /IFS= read -r RD_SECRET/)
  assert.match(script, /umask 077/)
  // The restrictive umask is confined to the subshell that writes the file.
  assert.equal(/^umask 077/m.test(script), false, 'umask must not leak to the harness')
})

await check('without a secret, nothing is read from stdin', () => {
  const { script, input } = startCommand(config, '/usr/bin/dsh')
  assert.equal(input, undefined)
  assert.equal(script.includes('read -r'), false)
  // A stale file from an earlier start is still removed.
  assert.match(script, /rm -f "\$RD_ENV"/)
})

await check('both launch methods go through the same wrapper', () => {
  const { script } = startCommand(config, '/usr/bin/dsh', { secret: SECRET })
  const wrapperStarts = script.match(/'sh' '-c' 'f=/g) ?? []
  assert.equal(wrapperStarts.length, 3, 'systemd-run, setsid and plain nohup must all use the wrapper')
  assert.ok(script.includes('exec "$@"'))
})

await check('the wrapper puts the directory dsh was found in first on PATH', () => {
  const { script } = startCommand(config, "/home/o'neil/.local/opt/node/bin/dsh")
  assert.ok(script.includes('PATH='), 'the user manager PATH has no npm global bin')
  assert.equal((script.match(/'/g) ?? []).length % 2, 0, 'a quote in the path must not unbalance the script')
  const { script: bare } = startCommand(config, 'dsh')
  assert.equal(bare.includes('PATH='), false, 'a bare name has no directory to add')
})

await check('the secret read-back finds the harness like the stop does, and prints only on stdout', async () => {
  /** @type {string[]} */
  const commands = []
  const answer = (stdout) => ({ exec: async (command) => { commands.push(command); return { code: 0, stdout, stderr: '' } } })
  assert.equal(await readLinkSecret(answer(`LINKSECRET=${SECRET}\n`), config), SECRET)
  const [script] = commands
  assert.match(script, /systemctl --user show -p MainPID --value 'dsh-ssh-desktop-3080'/)
  assert.match(script, /dsh-ssh-desktop-3080\.pid/)
  assert.match(script, /\/proc\/\$p\/environ/)
  assert.ok(script.includes(`s/^${LINK_SECRET_ENV}=//p`))
  assert.equal((script.match(/'/g) ?? []).length % 2, 0, 'balanced quotes')
  // Anything that is not a secret this app could have made is refused.
  for (const bad of ['LINKSECRET=\n', 'LINKSECRET=abc\n', `LINKSECRET=${SECRET}; rm -rf ~\n`, 'garbage']) {
    assert.equal(await readLinkSecret(answer(bad), config), undefined, JSON.stringify(bad))
  }
})

await check('a malformed secret is refused before anything is sent', () => {
  assert.throws(() => startCommand(config, '/usr/bin/dsh', { secret: 'short' }), /hex/)
  assert.throws(() => startCommand(config, '/usr/bin/dsh', { secret: `${'a'.repeat(64)}'; rm -rf ~` }), /hex/)
  assert.throws(() => startCommand(config, '/usr/bin/dsh', { secret: 'A'.repeat(64) }), /hex/)
})

// ------------------------------------------------------------------ execution

/** A POSIX shell to run the script with, or undefined to skip. */
function findShell() {
  const candidates = ['sh', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'command -v nohup >/dev/null && echo yes'], { encoding: 'utf8' })
    if (probe.status === 0 && probe.stdout.trim() === 'yes') return candidate
  }
  return undefined
}

/** Forward slashes: a POSIX shell on Windows accepts `C:/…` but not `C:\…`. */
const posix = (path) => path.replace(/\\/g, '/')

const shell = findShell()
if (shell === undefined) {
  console.log('skip the start script runs under sh (no POSIX sh with nohup on this machine)')
} else {
  await check('the start script runs, and the harness receives the secret through its environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-ssh-start-'))
    try {
      const workspace = join(home, 'work')
      mkdirSync(workspace)
      const bin = join(home, 'bin')
      mkdirSync(bin)
      // /usr/bin can contain a working systemd user manager on a developer's
      // Linux machine. It does not inherit our temporary HOME. Force the POSIX
      // fallback instead of accidentally starting a real transient user unit.
      const systemctl = join(bin, 'systemctl')
      writeFileSync(systemctl, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const fakeDsh = join(home, 'fake-dsh')
      writeFileSync(
        fakeDsh,
        [
          '#!/bin/sh',
          `printf 'SECRET=%s\\n' "\${${LINK_SECRET_ENV}:-none}"`,
          'printf "ARGS=%s\\n" "$*"',
          'printf "CWD=%s\\n" "$(pwd)"',
          'printf "FULLPATH=%s\\n" "$PATH"',
          'echo "dsh web: http://127.0.0.1:3080/?token=fake"',
          '',
        ].join('\n'),
      )
      chmodSync(fakeDsh, 0o755)

      const local = normalize({ target: 'x', remoteWorkspace: posix(workspace), remoteProfile: 'web', remotePort: 3999 })
      const { script, input } = startCommand(local, posix(fakeDsh), { secret: SECRET })
      const run = spawnSync(shell, ['-c', script], {
        input,
        encoding: 'utf8',
        env: { ...process.env, HOME: posix(home), PATH: `${posix(bin)}:/usr/bin:/bin:${process.env.PATH ?? ''}` },
        timeout: 20_000,
      })
      assert.equal(run.status, 0, `start script failed: ${run.stderr}`)
      assert.match(run.stdout, /^STARTED=(nohup|setsid)$/m)

      const logFile = join(home, '.dsh', 'dsh-ssh-desktop-3999.log')
      const deadline = Date.now() + 10_000
      let log = ''
      while (Date.now() < deadline) {
        log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
        if (log.includes('dsh web:')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.match(log, new RegExp(`^SECRET=${SECRET}$`, 'm'), `the harness did not get the secret; log:\n${log}`)
      assert.match(log, /^ARGS=--profile web --no-open --port 3999$/m)
      // `#!/usr/bin/env node` must find the node beside dsh, not the system's.
      // (Compared as a prefix: on Windows the directory itself holds a drive colon.)
      assert.ok(log.includes(`\nFULLPATH=${posix(home)}:`), `dsh's directory is not first on PATH; log:\n${log}`)
      assert.equal(existsSync(join(home, '.dsh', 'dsh-ssh-desktop-3999.env')), false, 'the one-shot env file must be deleted')
      assert.equal(existsSync(join(home, '.dsh', 'dsh-ssh-desktop-3999.pid')), true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  await check('a start with no secret on stdin fails instead of starting unprotected', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-ssh-start-'))
    try {
      mkdirSync(join(home, 'work'))
      const local = normalize({ target: 'x', remoteWorkspace: posix(join(home, 'work')), remotePort: 3998 })
      const { script } = startCommand(local, '/nonexistent/dsh', { secret: SECRET })
      const run = spawnSync(shell, ['-c', script], { input: '', encoding: 'utf8', env: { ...process.env, HOME: posix(home) } })
      assert.equal(run.status, 4, `expected exit 4, got ${String(run.status)}: ${run.stderr}`)
      assert.match(run.stderr, /no usable link secret/)
      assert.equal(run.stdout.includes('STARTED='), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

if (failures > 0) {
  console.error(`\n${String(failures)} start-script test(s) failed`)
  process.exit(1)
}
console.log('\nall start-script tests passed')
