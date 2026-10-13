/** Platform API regression tests; real Electron behavior is exercised in CI smoke. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { hideOnClose, notificationHelp, windowChrome } from '../src/main/platform.js'

if (typeof vm.SourceTextModule !== 'function') {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const mac = windowChrome('darwin', true)
assert.equal(mac.titleBarStyle, 'default')
assert.equal('titleBarOverlay' in mac, false)
assert.equal('backgroundMaterial' in mac, false)
assert.equal(windowChrome('win32', false).backgroundMaterial, 'acrylic')
assert.equal('backgroundMaterial' in windowChrome('linux', false), false)
for (const platform of ['darwin', 'win32', 'linux']) {
  assert.equal(hideOnClose(platform, { quitting: true, smoke: false, hasTray: true }), false)
  assert.equal(hideOnClose(platform, { quitting: false, smoke: true, hasTray: true }), false)
  assert.equal(hideOnClose(platform, { quitting: false, smoke: false, hasTray: true }), true)
  assert.equal(hideOnClose(platform, { quitting: false, smoke: false, hasTray: false }), platform === 'darwin')
}
assert.match(notificationHelp('darwin', false), /系统设置/)
assert.match(notificationHelp('win32', true), /\(dev\)/)
assert.doesNotMatch(notificationHelp('win32', false), /\(dev\)/)

for (const platform of ['darwin', 'win32', 'linux']) {
  const badges = [], overlays = [], flashes = [], counts = [], notifications = [], activated = []
  let win = { isDestroyed: () => false, isFocused: () => false, flashFrame: (value) => flashes.push(value) }
  if (platform === 'win32') win.setOverlayIcon = (...args) => overlays.push(args)
  class Notification extends EventEmitter {
    static isSupported() { return true }
    constructor(options) { super(); this.options = options; notifications.push(this) }
    show() {}
  }
  const electron = {
    Notification,
    app: { setBadgeCount: (count) => { assert.notEqual(platform, 'win32'); badges.push(count) } },
    nativeImage: { createFromBitmap: (buffer) => { assert.equal(platform, 'win32'); assert.equal(buffer.length, 1024); return 'bitmap' } },
  }
  const context = vm.createContext({ Buffer, process: { platform, stderr: { write() {} } } })
  const sourceUrl = new URL('../src/main/attention.js', import.meta.url)
  const mod = new vm.SourceTextModule(readFileSync(sourceUrl, 'utf8'), {
    context,
    initializeImportMeta(meta) { meta.url = sourceUrl.href },
  })
  await mod.link(async (specifier) => {
    const exports = specifier === 'electron' ? electron
      : specifier.startsWith('node:') ? await import(specifier)
      : await import(new URL(specifier, sourceUrl))
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await mod.evaluate()
  const attention = new mod.namespace.Attention({
    window: () => win, isShowing: () => false,
    activate: (id) => activated.push(id), onCount: (n) => counts.push(n),
  })
  attention.task('a', 'Server A', { title: 'Complete', outcome: 'completed' })
  assert.equal(attention.count(), 1)
  assert.equal(notifications.length, 1)
  assert.equal('icon' in notifications[0].options, platform !== 'darwin')
  assert.deepEqual(flashes, [true])
  notifications[0].emit('click')
  assert.deepEqual(activated, ['a'])
  assert.equal(attention.shown.size, 0)
  attention.setPageBadge('b', 2)
  attention.seen('a')
  assert.equal(attention.count(), 2)
  assert.equal(flashes.at(-1), false, 'viewing one server stops attention even when another page has a badge')
  attention.forget('b')
  assert.deepEqual(counts, [1, 3, 2, 0])
  if (platform === 'win32') {
    assert.equal(overlays.length, 4)
    assert.equal(overlays.at(-1)[0], null)
    assert.equal(badges.length, 0)
  } else {
    assert.deepEqual(badges, [1, 3, 2, 0])
    win = undefined
    attention.setPageBadge('a', 5)
    attention.forget('a')
    assert.deepEqual(badges.slice(-2), [5, 0], 'application badge works without a window')
  }
  console.log(`ok ${platform}: native chrome, close policy, notifications, unread aggregation and clearing`)
}
