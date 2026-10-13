/** Platform UI behavior, including focus routing and menu replay recursion. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

if (vm.SourceTextModule === undefined) {
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}

const here = dirname(fileURLToPath(import.meta.url))

async function fixture(platform) {
  const context = vm.createContext({ process: { platform }, console, URL, setTimeout, clearTimeout })
  let focused = null
  let applicationMenu
  let installations = 0
  class Contents extends EventEmitter {
    constructor() { super(); this.events = []; this.native = []; this.urls = []; this.ignored = false }
    isDestroyed() { return false }
    getTitle() { return 'DSH' }
    focus() { focused = this }
    setIgnoreMenuShortcuts(value) { this.ignored = value }
    setWindowOpenHandler(handler) { this.windowHandler = handler }
    loadURL(url) { this.urls.push(url); return Promise.resolve() }
    close() { this.emit('destroyed') }
    reload() { this.native.push('reload') }
    toggleDevTools() { this.native.push('devtools') }
    undo() { this.native.push('undo') }
    redo() { this.native.push('redo') }
    cut() { this.native.push('cut') }
    copy() { this.native.push('copy') }
    paste() { this.native.push('paste') }
    delete() { this.native.push('delete') }
    selectAll() { this.native.push('selectAll') }
    sendInputEvent(input) {
      this.events.push(input)
      const event = { prevented: false, preventDefault() { this.prevented = true } }
      this.emit('before-input-event', event, {
        type: input.type, key: input.keyCode, meta: input.modifiers.includes('meta'),
        control: input.modifiers.includes('control'), shift: input.modifiers.includes('shift'), alt: false,
      })
      // Electron would redispatch an accelerator if replay did not suppress it.
      if (platform === 'darwin' && input.type === 'keyDown' && input.keyCode === 'Z' && !this.ignored && !event.prevented) {
        throw new Error('editing replay would recurse into the native menu')
      }
    }
  }
  const electron = {
    app: { name: 'DSH SSH Desktop', getLocale: () => 'en' },
    Menu: {
      buildFromTemplate: (template) => ({ items: template }),
      setApplicationMenu: (menu) => { applicationMenu = menu; installations += 1 },
    },
    webContents: { getFocusedWebContents: () => focused },
    WebContentsView: class {
      constructor() { this.webContents = new Contents() }
      setBackgroundColor() {}
      setVisible() {}
      setBounds() {}
    },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) },
    ipcMain: { handle() {}, on() {} },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal() {} },
  }
  const modules = new Map()
  async function load(identifier) {
    if (modules.has(identifier)) return modules.get(identifier)
    const promise = (async () => {
      if (identifier === 'electron' || identifier.startsWith('node:')) {
        const exports = identifier === 'electron' ? electron : await import(identifier)
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
        }, { context, identifier })
      }
      const module = new vm.SourceTextModule(readFileSync(fileURLToPath(identifier), 'utf8'), {
        context, identifier, initializeImportMeta: (meta) => { meta.url = identifier },
      })
      await module.link((specifier) => load(specifier.startsWith('.') ? new URL(specifier, identifier).href : specifier))
      return module
    })()
    modules.set(identifier, promise)
    return promise
  }
  const menusModule = await load(pathToFileURL(resolve(here, '../src/main/menus.js')).href)
  await menusModule.evaluate()
  const viewsModule = await load(pathToFileURL(resolve(here, '../src/main/remote-views.js')).href)
  await viewsModule.evaluate()
  const home = new Contents()
  const host = {
    webContents: home, contentView: { addChildView() {}, removeChildView() {} },
    isDestroyed: () => false, getContentSize: () => [1280, 820], isMinimized: () => false,
    show() {}, setTitle() {},
    ...(platform === 'darwin' ? {} : { setTitleBarOverlay() {} }),
  }
  const configs = [{ id: 'a', name: 'Server A' }, { id: 'b', name: 'Server B' }]
  const actions = []
  const views = new viewsModule.namespace.RemoteViews({
    manager: { list: () => configs, snapshot: () => ({ phase: 'ready' }), boundPort: (id) => id === 'a' ? 3080 : 3081 },
    host: () => host, onHide() {}, onViewAdded() {}, onChange() {}, bridge: {},
    actions: Object.fromEntries(['openManager', 'reconnect', 'restart', 'testNotification', 'about', 'quit']
      .map((name) => [name, (id) => actions.push([name, id])])),
  })
  return {
    menus: menusModule.namespace, views, Contents, configs, actions,
    focus: (contents) => { focused = contents },
    menu: () => applicationMenu, installations: () => installations,
  }
}

const mac = await fixture('darwin')
mac.views.open('a') // Host deliberately has no Windows-only title-bar method.
const remote = mac.views.views.get('a').view.webContents
const manager = new mac.Contents()
const refresh = mac.menus.installApplicationMenu({
  connectionItems: () => mac.views.applicationItems(),
  editRemote: (contents, command) => mac.views.editFocused(contents, command),
  reloadRemote: (contents) => mac.views.reloadFocused(contents),
})
const submenu = (label) => mac.menu().items.find((item) => item.label === label).submenu
const clickEdit = (label) => submenu('Edit').find((item) => item.label === label).click()

assert.ok(submenu('DSH SSH Desktop').some((item) => item.role === 'quit'))
assert.ok(submenu('Window').some((item) => item.role === 'close'))
assert.equal(submenu('Edit').find((item) => item.label === 'Redo').accelerator, 'Cmd+Shift+Z')
mac.focus(manager)
clickEdit('Undo')
assert.deepEqual(manager.native, ['undo'], 'manager edits stay in the focused local form')
assert.equal(remote.events.length, 0)
mac.focus(remote)
clickEdit('Undo')
clickEdit('Redo')
assert.deepEqual(remote.events.map((event) => [event.type, event.keyCode, [...event.modifiers]]), [
  ['keyDown', 'Z', ['meta']], ['keyUp', 'Z', ['meta']],
  ['keyDown', 'Z', ['meta', 'shift']], ['keyUp', 'Z', ['meta', 'shift']],
])
assert.equal(remote.native.length, 0, 'remote editing does not use Chromium native history')
console.log('ok   native menu edits target manager or remote editor without replay recursion')

const key = (contents, input) => {
  const event = { prevented: false, preventDefault() { this.prevented = true } }
  contents.emit('before-input-event', event, { type: 'keyDown', meta: false, control: false, alt: false, shift: false, ...input })
  return event
}
assert.equal(key(remote, { key: 'z', meta: true }).prevented, false)
assert.equal(remote.ignored, true, 'physical Cmd+Z reaches the remote editor')
key(remote, { key: 'q', meta: true })
assert.equal(remote.ignored, false, 'Cmd+Q still reaches the application menu')
const loads = remote.urls.length
assert.equal(key(remote, { key: 'r', meta: true }).prevented, true)
assert.equal(remote.urls.length, loads + 1)
assert.equal(key(remote, { key: 'r', control: true }).prevented, false)
assert.equal(key(remote, { key: 'i', meta: true, alt: true }).prevented, true)
assert.equal(remote.native.at(-1), 'devtools')
console.log('ok   Cmd+R and Cmd+Option+I target remote views; editing does not swallow Cmd+Q')

mac.focus(manager)
submenu('View').find((item) => item.label === 'Reload Page').click()
assert.equal(manager.native.at(-1), 'reload', 'reload targets the manager while it has focus')
const popup = new mac.Contents()
remote.emit('did-create-window', { webContents: popup })
mac.focus(popup)
clickEdit('Undo')
assert.equal(popup.events.length, 2, 'popup history also receives platform key events')
submenu('View').find((item) => item.label === 'Reload Page').click()
assert.equal(popup.native.at(-1), 'reload', 'popup reload stays in that popup')
popup.emit('destroyed')
assert.equal(mac.views.editFocused(popup, 'undo'), false, 'closed popup is forgotten')
console.log('ok   native actions also target popup WebContents and clean up after close')

const installed = mac.installations()
refresh()
refresh()
assert.equal(mac.installations(), installed, 'ordinary state pushes do not rebuild the menu')
let connectionMenu = submenu('Connections')
connectionMenu.find((item) => item.id === 'a:testNotification').click()
assert.deepEqual(mac.actions.at(-1), ['testNotification', 'a'])
connectionMenu.find((item) => item.label === 'Switch Server').submenu[0].click()
refresh()
assert.equal(mac.views.active, 'b')
assert.equal(mac.installations(), installed + 1)
connectionMenu = submenu('Connections')
connectionMenu.find((item) => item.id === 'b:restart').click()
assert.deepEqual(mac.actions.at(-1), ['restart', 'b'])
assert.ok(connectionMenu.some((item) => item.id === 'b:reconnect'))
console.log('ok   connection actions and server switching refresh only when the menu changes')

const windows = await fixture('win32')
windows.menus.installApplicationMenu()
assert.ok(windows.menu().items.every((item) => item.visible === false))
const winEdit = windows.menus.remoteEditItems(() => {})
assert.equal(winEdit.find((item) => item.label === 'Redo').accelerator, 'Ctrl+Y')
windows.views.open('a')
const winRemote = windows.views.views.get('a').view.webContents
assert.equal(key(winRemote, { key: 'r', control: true }).prevented, true)
assert.equal(key(winRemote, { key: 'i', control: true, shift: true }).prevented, true)
console.log('ok   Windows caption menus and Control shortcuts remain available')

const exposed = {}
const calls = []
vm.runInNewContext(readFileSync(resolve(here, '../src/preload/remote.cjs'), 'utf8'), {
  require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args) } },
  }),
  process: { platform: 'darwin', isMainFrame: true },
  location: { protocol: 'http:', hostname: '127.0.0.1' },
  navigator: { language: 'en' },
  // Any access would mean Windows caption code leaked into the Mac preload.
  document: new Proxy({}, { get() { throw new Error('macOS must not inject a Windows caption') } }),
})
assert.deepEqual([...exposed.dshSshDesktop.capabilities], ['notify', 'setBadge', 'revealInEditor'])
await exposed.dshSshDesktop.setBadge(3)
assert.deepEqual(calls, [['dsh-bridge:setBadge', 3]])
console.log('ok   macOS remote preload preserves the bridge without touching caption DOM')

console.log('\nall macOS UI tests passed')
