/**
 * dsh-ssh-desktop main process.
 *
 * One window, three layers, each its own web contents:
 *
 *   top     the connection manager — a modal dialog in a transparent view,
 *           opened from "应用 → 连接管理" and closed with its ×
 *   middle  the server's DSH UI — one view per connection (remote-views.js)
 *   bottom  the home page — the window's own contents, seen only while no
 *           remote UI is on screen
 *
 * Finished tasks reported by the server plugin become system notifications
 * and a taskbar badge (attention.js) while the user is not looking.
 *
 * Nothing here runs DSH: the harness lives on the server.
 *
 * @module dsh-ssh-desktop/main
 */

import { cpSync, existsSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeFile } from 'node:fs/promises'

import {
  BrowserWindow, Menu, Tray, WebContentsView, app, dialog, session as electronSession, ipcMain, nativeImage, nativeTheme, powerMonitor, shell,
} from 'electron'

import { RemoteSession, createStore, describeDestination, redact, resolveSshTarget } from '@dsh-ssh/core'

import { Attention } from './attention.js'
import { ConnectionManager } from './connections.js'
import { contextMenuItems, installApplicationMenu, messages, nativeEditItems, popupAt } from './menus.js'
import { FileLog } from './file-log.js'
import { Installer } from './installer.js'
import { TITLEBAR_HEIGHT, isConnectionWindowCaller, isMenuRequest, partitionFor } from './policy.js'
import { RemoteViews } from './remote-views.js'
import { hideOnClose, notificationHelp, windowChrome } from './platform.js'

const here = dirname(fileURLToPath(import.meta.url))
const HOME_PAGE = join(here, '..', 'renderer', 'home.html')
const HOME_PAGE_URL = pathToFileURL(HOME_PAGE).href
const HOME_PRELOAD = join(here, '..', 'preload', 'home.cjs')
const MANAGER_PAGE = join(here, '..', 'renderer', 'connection.html')
const MANAGER_PAGE_URL = pathToFileURL(MANAGER_PAGE).href
const MANAGER_PRELOAD = join(here, '..', 'preload', 'connection.cjs')
/** The app icon (scripts/make-icon.mjs): the window, the taskbar and the dev Start Menu shortcut. */
const APP_ICON = join(here, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
const TRAY_ICON = process.platform === 'darwin'
  ? join(here, '..', '..', 'assets', 'trayTemplate.png')
  : APP_ICON

/** The product's directory under the platform's application-data directory. */
const DATA_DIR_NAME = 'DSH SSH Desktop'
/** What builds up to 0.1.0 called it. */
const LEGACY_DATA_DIR_NAME = 'dsh-ssh-desktop'

/**
 * Carry the saved connections, login cookies and logs over from the old data
 * directory, once: moved when possible, copied when something still holds a
 * file in it (the old version running). Nothing happens when the new one
 * already exists.
 * @param {string} legacy
 * @param {string} target
 */
function adoptLegacyDataDir(legacy, target) {
  if (!existsSync(legacy) || existsSync(target)) return
  try {
    renameSync(legacy, target)
  } catch {
    try {
      cpSync(legacy, target, { recursive: true })
    } catch (error) {
      process.stderr.write(`warning: could not move ${legacy} to ${target}: ${String(error)}\n`)
    }
  }
}

// ----------------------------------------------------------- test seams (dev only)

/**
 * Development and test overrides. All are ignored in a packaged build.
 *  - DSH_SSH_DESKTOP_USER_DATA: an isolated profile directory.
 *  - DSH_SSH_DESKTOP_TEST_TRANSPORT: a module whose `createTransport(config)`
 *    replaces system ssh (the smoke test's fake server).
 *  - DSH_SSH_DESKTOP_SMOKE: print `[smoke]` trace lines, connect the first
 *    connection at startup, and quit after the first authenticated page load.
 *  - DSH_SSH_DESKTOP_CAPTURE (with SMOKE): save PNGs of each layer just before quitting.
 */
const dev = !app.isPackaged
const smoke = dev && process.env.DSH_SSH_DESKTOP_SMOKE === '1'
// One data directory for every build, named after the product like every
// folder the app owns: %APPDATA%\DSH SSH Desktop.
if (dev && process.env.DSH_SSH_DESKTOP_USER_DATA) {
  app.setPath('userData', resolve(process.env.DSH_SSH_DESKTOP_USER_DATA))
} else {
  const dataDir = join(app.getPath('appData'), DATA_DIR_NAME)
  adoptLegacyDataDir(join(app.getPath('appData'), LEGACY_DATA_DIR_NAME), dataDir)
  app.setPath('userData', dataDir)
}
const capturePath = smoke ? process.env.DSH_SSH_DESKTOP_CAPTURE : undefined
const fileLog = new FileLog(join(app.getPath('userData'), 'logs'))
const trace = smoke
  ? (line) => {
      process.stdout.write(`[smoke] ${line}\n`)
      // The run is over once the remote UI has loaded authenticated.
      if (line.startsWith('navigated 200 ')) setTimeout(() => { void finishSmoke() }, 300)
    }
  : () => {}

/** Report what the window shows, optionally photograph each layer, then quit. */
async function finishSmoke() {
  const win = mainWindow
  if (win !== undefined && !win.isDestroyed() && managerView !== undefined) {
    // Read from the DOM: a capture of a covered page may be a stale frame.
    await new Promise((r) => setTimeout(r, 400))
    const chip = await managerView.webContents
      .executeJavaScript("document.getElementById('chip')?.textContent ?? ''")
      .catch(() => '')
    trace(`manager shows ${String(chip)}`)
    trace(`manager ${managerOpen ? 'open' : 'closed'}`)
    // The page bridge: present on the remote page, validated, and nowhere else.
    const remote = remoteViews.active === undefined ? undefined : remoteViews.views.get(remoteViews.active)
    if (remote !== undefined) {
      const probe = await remote.view.webContents.executeJavaScript(`(async () => {
        const b = window.dshSshDesktop
        if (b === undefined) return 'absent'
        try { await b.setBadge(2) } catch (e) { return 'setBadge refused' }
        try { await b.revealInEditor({ path: 'relative/path' }); return 'bad path accepted' } catch (e) { /* expected */ }
        try { await b.setBadge(5000); return 'bad badge accepted' } catch (e) { /* expected */ }
        return 'protocol ' + b.protocol + ' ' + b.capabilities.join(',')
      })()`).catch((error) => `error ${String(error)}`)
      trace(`bridge ${String(probe)}`)
      trace(`badge ${String(attention.count())}`)
    }
    const managerBridge = await managerView.webContents.executeJavaScript('typeof window.dshSshDesktop').catch(() => 'error')
    trace(`manager bridge ${String(managerBridge)}`)
    // Under a remote view the home caption must not be a drag region.
    const homeRegion = await win.webContents
      .executeJavaScript("getComputedStyle(document.querySelector('.titlebar')).appRegion ?? ''")
      .catch(() => 'error')
    trace(`home caption region ${String(homeRegion)}`)
    trace(`showing ${remoteViews.active === undefined ? 'home page' : `remote view ${remoteViews.active}`}`)
    if (capturePath) {
      const { writeFileSync } = await import('node:fs')
      const save = async (contents, suffix) => {
        const shot = await contents.capturePage()
        writeFileSync(resolve(capturePath.replace(/\.png$/i, `-${suffix}.png`)), shot.toPNG())
      }
      for (const [id, { view }] of remoteViews.views) await save(view.webContents, `remote-${id}`)
      openManager()
      await new Promise((r) => setTimeout(r, 600))
      await save(managerView.webContents, 'manager')
      await save(win.webContents, 'home')
    }
  }
  app.quit()
}

async function sessionFactory() {
  const modulePath = dev ? process.env.DSH_SSH_DESKTOP_TEST_TRANSPORT : undefined
  if (modulePath === undefined || modulePath === '') return undefined
  const mod = await import(pathToFileURL(resolve(modulePath)).href)
  return (config) => new RemoteSession(config, { transportFactory: mod.createTransport })
}

/**
 * Whether Chromium's process sandbox is off for this run. Nothing in the app
 * asks for it; only a test runner that starts Electron at Low integrity (where
 * the sandbox cannot initialise, see setup-electron-runtime.cmd) passes it.
 * The manager says so rather than letting it pass unnoticed, because the
 * remote page then runs without that boundary.
 */
const sandboxDisabled = app.commandLine.hasSwitch('no-sandbox')
if (sandboxDisabled) {
  process.stderr.write('warning: running with --no-sandbox; remote pages are not process-sandboxed\n')
  fileLog.write('app', 'warning: running with --no-sandbox; remote pages are not process-sandboxed')
}

// --------------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { focusMainWindow() })
  app.on('activate', () => { if (!quitting) focusMainWindow() })
  void app.whenReady().then(start)
}

/** @type {ConnectionManager} */
let manager
/** @type {RemoteViews} */
let remoteViews
/** @type {Attention} */
let attention
/** @type {Installer} */
let installer
/** @type {BrowserWindow | undefined} */
let mainWindow
/** The connection manager dialog's view. */
/** @type {WebContentsView | undefined} */
let managerView
let managerOpen = false
let refreshApplicationMenu = () => {}

async function start() {
  fileLog.write('app', `start: dsh-ssh-desktop ${app.getVersion()}${dev ? ' (development)' : ''} · Electron ${process.versions.electron} · ${process.platform} ${process.getSystemVersion()}`)
  const store = createStore({ dir: app.getPath('userData') })
  manager = new ConnectionManager({
    store,
    createSession: await sessionFactory(),
    onLine: (id, line) => { fileLog.write(String(manager.list().find((c) => c.id === id)?.name ?? id), line) },
  })
  manager.load()
  installer = new Installer({ manager })
  for (const config of manager.list()) refreshDestination(config.target)

  registerNotificationIdentity()

  const nameOf = (id) => manager.list().find((c) => c.id === id)?.name ?? id
  attention = new Attention({
    window: () => mainWindow,
    isShowing: (id) => {
      const win = mainWindow
      return win !== undefined && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized() && remoteViews.active === id
    },
    onCount: (count) => { updateTray(count) },
    activate: (id) => {
      closeManager()
      if (manager.snapshot(id).phase === 'ready') remoteViews.open(id)
      focusMainWindow()
      attention.seen(id)
    },
    trace,
  })
  manager.on('task', (id, task) => { attention.task(id, nameOf(id), task) })

  refreshApplicationMenu = installApplicationMenu({
    openManager: () => { openManager() },
    showMainWindow: () => { focusMainWindow() },
    about: () => { showAbout() },
    editRemote: (contents, command) => remoteViews?.editFocused(contents, command) ?? false,
    reloadRemote: (contents) => remoteViews?.reloadFocused(contents) ?? false,
    connectionItems: () => remoteViews?.applicationItems() ?? [],
  })
  remoteViews = new RemoteViews({
    manager,
    host: () => mainWindow,
    onHide: () => {
      showHomeCaption()
      setHomeCovered(false)
    },
    onShow: () => { setHomeCovered(true) },
    onViewAdded: () => { raiseManager() },
    onChange: () => {
      markSeen()
      pushState()
    },
    bridge: {
      notify: (id, content) => { attention.pageNotify(id, nameOf(id), content) },
      setBadge: (id, count) => { attention.setPageBadge(id, count) },
    },
    trace,
    actions: {
      openManager: () => { openManager() },
      reconnect: (id) => { void reconnect(id) },
      restart: (id) => { void confirmRestart(id) },
      testNotification: (id) => { testNotification(id) },
      about: () => { showAbout() },
      quit: () => { app.quit() },
    },
  })
  manager.on('change', () => { pushState() })
  manager.on('ready', (id) => {
    trace(`ready ${id}`)
    remoteViews.onReady(id)
  })

  // A laptop lid closing is the most common way a forward dies unnoticed.
  powerMonitor.on('resume', () => {
    trace('resume')
    manager.resume()
  })

  registerIpc()
  createMainWindow()
  if (!smoke) {
    try { createTray() } catch (error) {
      fileLog.write('app', `could not create the tray icon: ${String(error)}`)
    }
  }
  // Nothing on screen yet but the home page: start in the manager.
  openManager()

  if (smoke) {
    const first = manager.list()[0]
    if (first !== undefined) {
      void connectAndShow(first.id).then(() => {
        const snap = manager.snapshot(first.id)
        if (snap.phase === 'ready') return
        // A failed smoke run must end, and say why.
        trace(`connect failed: ${String(snap.message)}`)
        void finishSmoke()
      })
    }
  }
}

/**
 * Windows shows an app's toasts only when a Start Menu shortcut carries the
 * same AppUserModelID; without one they are dropped silently (the taskbar
 * badge still works, which is how this was found). The installer will create
 * that shortcut; a dev run creates its own, pointing at the runtime it runs
 * from. Smoke runs leave the Start Menu alone.
 */
function registerNotificationIdentity() {
  if (process.platform !== 'win32') return
  const id = dev ? 'dsh-ssh-desktop.dev' : 'dsh-ssh-desktop'
  app.setAppUserModelId(id)
  if (!dev || smoke) return
  const link = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DSH SSH Desktop (dev).lnk')
  const options = {
    target: process.execPath,
    args: `"${app.getAppPath()}"`,
    description: 'dsh-ssh-desktop (development build)',
    icon: existsSync(APP_ICON) ? APP_ICON : process.execPath,
    iconIndex: 0,
    appUserModelId: id,
  }
  try {
    const current = existsSync(link) ? shell.readShortcutLink(link) : undefined
    const same = current !== undefined && current.target === options.target && current.args === options.args
      && current.appUserModelId === id && current.icon === options.icon
    if (!same) shell.writeShortcutLink(link, current === undefined ? 'create' : 'replace', options)
  } catch (error) {
    process.stderr.write(`warning: could not register the Start Menu shortcut notifications need: ${String(error)}\n`)
  }
}

// Closing the window hides it to the tray (see createMainWindow); quitting is
// the tray's or the application menu's "退出", and runs the close policy.
app.on('will-quit', () => { trace('will quit') })
app.on('window-all-closed', () => { trace('windows closed'); if (process.platform !== 'darwin') app.quit() })

/** Set once a real quit starts, so the window's close is let through. */
let quitting = false
let shutdownDone = false
let shuttingDown = false
app.on('before-quit', (event) => {
  quitting = true
  if (shutdownDone || manager === undefined) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  // The close policy may need an ssh round trip; never let it hold the app
  // hostage. The stop command is spawned before this waits, so it still
  // reaches the server if the timeout wins.
  const timeout = new Promise((r) => setTimeout(r, 8_000))
  void Promise.race([manager.shutdownAll('the app is quitting'), timeout]).finally(() => {
    fileLog.write('app', 'exit')
    shutdownDone = true
    trace('shutdown: dispose UI')
    tray?.destroy()
    tray = undefined
    remoteViews?.closeAll()
    if (managerView !== undefined && !managerView.webContents.isDestroyed()) managerView.webContents.close()
    trace('shutdown: quit')
    app.quit()
  })
})

// Nothing in this app embeds <webview>.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => { event.preventDefault() })
})

// ------------------------------------------------------------------ main window

function focusMainWindow() {
  if ((mainWindow === undefined || mainWindow.isDestroyed()) && remoteViews !== undefined && !quitting) {
    createMainWindow()
    openManager()
  }
  const win = mainWindow
  if (win === undefined || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Lock a local page down: it has nowhere to go, popups are refused, and only
 * explicit web links leave, to the user's browser.
 * @param {import('electron').WebContents} contents
 * @param {import('electron').BaseWindow} window
 */
function lockLocalPage(contents, window) {
  contents.on('will-navigate', (event) => { event.preventDefault() })
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('context-menu', (_event, params) => {
    const items = contextMenuItems(params)
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window })
  })
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'DSH',
    icon: APP_ICON,
    show: !smoke || Boolean(capturePath),
    ...windowChrome(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: HOME_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
  mainWindow = win
  lockLocalPage(win.webContents, win)
  void win.loadFile(HOME_PAGE)

  const view = new WebContentsView({
    webPreferences: {
      preload: MANAGER_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
  // Transparent: the page draws its own mask over whatever is underneath.
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  win.contentView.addChildView(view)
  lockLocalPage(view.webContents, win)
  void view.webContents.loadFile(MANAGER_PAGE)
  managerView = view

  const layout = () => {
    remoteViews.layout()
    const [width, height] = win.getContentSize()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  win.on('resize', layout)
  layout()
  win.on('focus', () => { markSeen() })
  // × hides to the tray: connections, forwards and notifications keep going.
  win.on('close', (event) => {
    if (!hideOnClose(process.platform, { quitting, smoke, hasTray: tray !== undefined })) return
    event.preventDefault()
    win.hide()
    if (process.platform === 'win32' && tray !== undefined && !trayHintShown) {
      trayHintShown = true
      tray.displayBalloon({
        iconType: 'info',
        title: 'DSH SSH Desktop 仍在运行',
        content: '已收起到托盘，连接和任务通知照常。要退出，请在托盘图标的右键菜单里选「退出」。',
      })
    }
  })
  win.on('closed', () => {
    trace('main window closed')
    // WebContentsView contents have their own lifetime, even if the host dies.
    // A real quit already closed them in before-quit. Calling close twice while
    // a WebContents is still being destroyed can stall Electron's native exit.
    if (!quitting) {
      remoteViews.closeAll()
      if (managerView !== undefined && !managerView.webContents.isDestroyed()) managerView.webContents.close()
    }
    mainWindow = undefined
    managerView = undefined
    managerOpen = false
  })
}

/**
 * Tell the home page whether a remote view covers it, so its caption stops
 * being a drag region underneath the remote page's own (see home.css).
 * @param {boolean} covered
 */
function setHomeCovered(covered) {
  const win = mainWindow
  if (win === undefined || win.isDestroyed()) return
  win.webContents.send('dsh-home:covered', covered)
  trace(`home ${covered ? 'covered' : 'uncovered'}`)
}

/** Whatever connection the user is now looking at has nothing unseen. */
function markSeen() {
  const win = mainWindow
  if (win === undefined || win.isDestroyed() || !win.isFocused()) return
  if (remoteViews?.active !== undefined) attention?.seen(remoteViews.active)
}

/** @type {Tray | undefined} */
let tray
let trayHintShown = false

/** The notification-area icon: bring the window back, or quit for real. */
function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON)
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('DSH SSH Desktop')
  tray.on('click', () => { focusMainWindow() })
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DSH SSH Desktop', click: () => { focusMainWindow() } },
    { label: messages().connections, click: () => { openManager() } },
    { type: 'separator' },
    { label: messages().exit, click: () => { app.quit() } },
  ]))
}

/**
 * The tray tooltip carries the unread count while the window is hidden and
 * the taskbar badge with it.
 * @param {number} count
 */
function updateTray(count) {
  tray?.setToolTip(count === 0 ? 'DSH SSH Desktop' : `DSH SSH Desktop · ${String(count)} 条未读`)
}

/** Keep the manager dialog above every remote view. */
function raiseManager() {
  const win = mainWindow
  if (win === undefined || win.isDestroyed() || managerView === undefined) return
  win.contentView.addChildView(managerView)
}

function openManager() {
  const win = mainWindow
  if (win === undefined || win.isDestroyed() || managerView === undefined) return
  raiseManager()
  const [width, height] = win.getContentSize()
  managerView.setBounds({ x: 0, y: 0, width, height })
  managerView.setVisible(true)
  managerView.webContents.focus()
  managerOpen = true
  focusMainWindow()
}

function closeManager() {
  if (managerView === undefined) return
  managerView.setVisible(false)
  managerOpen = false
  // Hand the keyboard back to whatever is underneath.
  const active = remoteViews.active === undefined ? undefined : remoteViews.views.get(remoteViews.active)
  if (active !== undefined) active.view.webContents.focus()
  else mainWindow?.webContents.focus()
}

/** Caption symbols over the home page, whose overlay stays transparent. */
function homeCaption() {
  return { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' }
}

function showHomeCaption() {
  const win = mainWindow
  if (win === undefined || win.isDestroyed()) return
  if (process.platform === 'darwin') win.setBackgroundColor(windowChrome(process.platform, nativeTheme.shouldUseDarkColors).backgroundColor)
  else win.setTitleBarOverlay({ ...homeCaption(), height: TITLEBAR_HEIGHT })
  win.setTitle('DSH')
}

nativeTheme.on('updated', () => {
  if (remoteViews?.active === undefined) showHomeCaption()
})

// ------------------------------------------------------------------ menu actions

function showAbout() {
  const m = messages()
  const detail = `dsh-ssh-desktop ${app.getVersion()}\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`
  const options = { type: 'none', title: m.about, message: 'DSH 连接', detail, buttons: ['OK'], noLink: true }
  void (mainWindow === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(mainWindow, options))
}

/**
 * Restart the remote harness after an explicit confirmation: running agent
 * turns on the server are interrupted.
 * @param {string} id
 */
async function confirmRestart(id) {
  const options = {
    type: 'warning',
    title: messages().restartRemote.replace('…', ''),
    message: '重启服务器上的 DSH？',
    detail: '正在运行的任务会被中断；会话数据保留在服务器上。',
    buttons: ['重启', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const { response } = mainWindow === undefined
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(mainWindow, options)
  if (response === 0) await manager.restart(id)
}

/**
 * Show a sample notification now, or explain the platform's requirements.
 * @param {string} id
 */
function testNotification(id) {
  const name = manager.list().find((c) => c.id === id)?.name ?? id
  const explain = (detail) => {
    const options = { type: 'warning', title: messages().testNotification, message: '通知没有发出', detail, buttons: ['OK'], noLink: true }
    void (mainWindow === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(mainWindow, options))
  }
  const outcome = attention.test(id, name, (reason) => {
    explain(`系统拒绝了通知：${reason}\n${notificationHelp(process.platform, dev)}`)
  })
  if (outcome === 'unsupported') explain('这台电脑不支持系统通知。')
}

/**
 * Write everything useful for a bug report to one text file the user picks.
 * Tokens and the link secret never reach it: logs are redacted as they are
 * recorded (@dsh-ssh/core log), snapshots carry neither, and the whole text is
 * redacted once more on the way out.
 */
async function exportDiagnostics() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const options = {
    title: '导出诊断信息',
    defaultPath: join(app.getPath('downloads'), `dsh-ssh-desktop-diagnostics-${stamp}.txt`),
    filters: [{ name: '文本文件', extensions: ['txt'] }],
  }
  const choice = mainWindow === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(mainWindow, options)
  if (choice.canceled || choice.filePath === undefined) return { saved: false }
  const lines = [
    `dsh-ssh-desktop ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    `${process.platform} ${process.arch} ${process.getSystemVersion()} · sandbox ${sandboxDisabled ? 'OFF' : 'on'} · exported ${new Date().toISOString()}`,
    '',
  ]
  for (const config of manager.list()) {
    const { log, ...snapshot } = /** @type {any} */ (manager.snapshot(config.id))
    lines.push(
      `===== ${String(config.name)} (${String(config.id)})`,
      `config: ${JSON.stringify(config)}`,
      `destination: ${destinations.get(config.target)?.text ?? 'unresolved'}`,
      `window: ${JSON.stringify(remoteViews.info(config.id))}`,
      `state: ${JSON.stringify(snapshot)}`,
      '--- log',
      ...(Array.isArray(log) ? log : []),
      '',
    )
  }
  await writeFile(choice.filePath, redact(lines.join('\n')), 'utf8')
  return { saved: true, path: choice.filePath }
}

/** @param {string} id */
async function reconnect(id) {
  await manager.disconnect(id)
  await manager.connect(id)
}

// ------------------------------------------------------------------------ state

function fullState() {
  const sessions = {}
  for (const config of manager.list()) {
    sessions[config.id] = {
      ...manager.snapshot(config.id),
      window: remoteViews.info(config.id),
      destination: destinations.get(config.target) ?? null,
      installing: installer.running.has(config.id),
    }
  }
  return {
    connections: manager.list(),
    sessions,
    active: remoteViews.active ?? null,
    freePort: manager.freePort(),
    userData: app.getPath('userData'),
    sandboxDisabled,
  }
}

/**
 * What each ssh target resolves to (`ssh -G`), by target. Resolved in the
 * background when a connection is loaded or saved; the UI shows it once known.
 * @type {Map<string, { text: string, direct: boolean } | null>}
 */
const destinations = new Map()

/** @param {string} target */
function refreshDestination(target) {
  void resolveSshTarget(target).then((resolved) => {
    destinations.set(target, resolved === undefined ? null : {
      text: describeDestination(resolved),
      // ssh fell back to the name itself: no Host block matched it.
      direct: resolved.hostname === target.replace(/^[^@]*@/, ''),
    })
    pushState()
  })
}

/** One line for the home page about where things stand. */
function homeStatus() {
  const busy = { connecting: '正在连接', starting: '正在启动', stopping: '正在停止' }
  const ready = manager.list().filter((c) => manager.snapshot(c.id).phase === 'ready').map((c) => c.name)
  if (ready.length > 0) return `已连接 ${ready.join('、')}`
  for (const config of manager.list()) {
    const phase = manager.snapshot(config.id).phase
    if (phase in busy) return `${busy[phase]} ${config.name}…`
  }
  return manager.list().length === 0 ? '还没有服务器，先在连接管理里添加' : '尚未连接到服务器'
}

/** Coalesce bursts (the log grows line by line during a start) into one push. */
let pushTimer
function pushState() {
  if (pushTimer !== undefined) return
  pushTimer = setTimeout(() => {
    pushTimer = undefined
    refreshApplicationMenu()
    const win = mainWindow
    if (win === undefined || win.isDestroyed()) return
    win.webContents.send('dsh-home:status', homeStatus())
    if (managerView !== undefined && !managerView.webContents.isDestroyed()) {
      managerView.webContents.send('dsh:state', fullState())
    }
  }, 120)
}

// -------------------------------------------------------------------------- IPC

/**
 * Register a handler that answers only one local page: that exact page in its
 * own web contents, never a remote view (whose preload has no access to these
 * channels anyway).
 * @param {string} channel
 * @param {() => import('electron').WebContents | undefined} owner
 * @param {string} pageUrl
 * @param {(...args: any[]) => Promise<unknown> | unknown} fn
 * @param {boolean} [wrap] reply with `{ ok, result, state }` (the manager's shape).
 */
function handleFrom(channel, owner, pageUrl, fn, wrap = true) {
  ipcMain.handle(channel, async (event, ...args) => {
    const allowed = isConnectionWindowCaller(
      { senderId: event.sender.id, frameUrl: event.senderFrame?.url },
      { windowId: owner()?.id, pageUrl },
    )
    if (!allowed) throw new Error('refused: not the expected page')
    if (!wrap) return fn(...args)
    try {
      const result = await fn(...args)
      return { ok: true, result, state: fullState() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), state: fullState() }
    }
  })
}

/** @param {unknown} id */
function knownId(id) {
  if (typeof id !== 'string' || !manager.list().some((c) => c.id === id)) {
    throw new Error('unknown connection')
  }
  return id
}

/**
 * Connect, then show the remote UI and close the manager once ready. A
 * background reconnect only reloads a view that already exists.
 * @param {string} id
 */
async function connectAndShow(id) {
  await manager.connect(id)
  if (manager.snapshot(id).phase !== 'ready') return
  remoteViews.open(id)
  closeManager()
}

/**
 * After a disconnect or stop, a remote view that is on screen points at nothing:
 * step back to the home page under the manager.
 * @param {string} id
 */
function stepAside(id) {
  if (remoteViews.active === id) remoteViews.hide()
}

function registerIpc() {
  const managerContents = () => managerView?.webContents
  const handle = (channel, fn) => { handleFrom(channel, managerContents, MANAGER_PAGE_URL, fn) }
  handle('dsh:getState', () => undefined)
  handle('dsh:save', (record) => {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('invalid record')
    const saved = manager.save(record)
    if (!destinations.has(saved.target)) refreshDestination(saved.target)
    return saved
  })
  handle('dsh:remove', async (id) => {
    const known = knownId(id)
    await manager.remove(known)
    remoteViews.close(known)
    attention.forget(known)
    // Its login cookie and page storage go with it.
    await electronSession.fromPartition(partitionFor(known)).clearStorageData().catch(() => {})
  })
  handle('dsh:inspect', (id, options) => {
    const known = knownId(id)
    const opts = typeof options === 'object' && options !== null ? options : {}
    return installer.inspect(known, {
      dshTag: opts.dshTag === 'next' ? 'next' : 'latest',
      source: opts.source === 'official' || opts.source === 'mirror' ? opts.source : undefined,
    })
  })
  handle('dsh:install', async (id) => {
    const known = knownId(id)
    pushState()
    const result = await installer.run(known, (progress) => {
      managerView?.webContents.send('dsh:install-progress', { connection: known, ...progress })
    })
    manager.log(known, result.ok ? 'install: all steps finished' : `install: stopped at step ${String(result.failedStep)}`)
    return result
  })
  handle('dsh:exportDiagnostics', () => exportDiagnostics())
  handle('dsh:connect', (id) => connectAndShow(knownId(id)))
  handle('dsh:disconnect', async (id) => {
    const known = knownId(id)
    await manager.disconnect(known)
    stepAside(known)
    attention.forget(known)
  })
  handle('dsh:stop', async (id) => {
    const known = knownId(id)
    await manager.stop(known)
    stepAside(known)
    attention.forget(known)
  })
  handle('dsh:restart', async (id) => {
    const known = knownId(id)
    await manager.restart(known)
    if (manager.snapshot(known).phase !== 'ready') return
    remoteViews.open(known)
    closeManager()
  })
  handle('dsh:openUserData', () => shell.openPath(app.getPath('userData')))
  handle('dsh:openLogs', async () => {
    fileLog.write('app', 'the log directory was opened')
    return shell.openPath(fileLog.dir)
  })
  handle('dsh:close', () => { closeManager() })

  // The home page: open the manager and the caption menus, nothing more.
  const homeContents = () => mainWindow?.webContents
  handleFrom('dsh-home:openManager', homeContents, HOME_PAGE_URL, () => { openManager() }, false)
  handleFrom('dsh-home:menu', homeContents, HOME_PAGE_URL, (name, x, y) => {
    if (!isMenuRequest(name, x, y)) throw new Error('invalid menu request')
    const win = mainWindow
    if (win === undefined || win.isDestroyed()) return undefined
    const m = messages()
    const items = name === 'edit' ? nativeEditItems() : [
      { label: m.connections, click: () => { openManager() } },
      ...remoteViews.showItems(),
      { type: 'separator' },
      { label: m.about, click: () => { showAbout() } },
      { label: m.exit, click: () => { app.quit() } },
    ]
    return popupAt(win, win.webContents, items, x, y)
  }, false)
}
