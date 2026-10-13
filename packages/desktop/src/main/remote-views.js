/**
 * Remote views: the server's own DSH web UI, one WebContentsView per
 * connection, layered over the main window's home page and under the
 * connection manager dialog.
 *
 * The main window is a single BrowserWindow. Its own web contents is the local
 * home page; each remote UI lives in a separate WebContentsView with its own
 * partition and preload, shown above it; the manager dialog is another view on
 * top. None of them share a web contents: a preload is bound to its web
 * contents, so navigating one between a local page and remote code would hand
 * the local bridge to the remote page.
 *
 * The remote page is remote code, so its view is locked down the way a browser
 * tab would be and then some: no Node, sandboxed, context-isolated, navigation
 * pinned to the forward's origin, popups outside it sent to the user's browser,
 * and only the permissions in `policy.permissionAllowed`. Its preload draws the
 * Windows caption outside macOS and exposes one thing to
 * the page: the `window.dshSshDesktop` bridge (notify, setBadge,
 * revealInEditor), every call of which is checked here.
 *
 * Each connection gets a persistent partition, so the harness's login cookie
 * survives an app restart; the view loads the clean root first and escalates to
 * a token URL only on a 401 (see `policy.nextAuthStep`).
 *
 * @module dsh-ssh-desktop/remote-views
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Menu, WebContentsView, session as electronSession, ipcMain, nativeTheme, shell } from 'electron'

import { contextMenuItems, editingShortcut, isEditingShortcut, messages, popupAt, remoteEditItems } from './menus.js'
import {
  TITLEBAR_HEIGHT,
  badgeInput,
  baseUrl,
  isBridgeCaller,
  isCaptionColor,
  isMenuRequest,
  navigationDecision,
  nextAuthStep,
  notifyInput,
  partitionFor,
  permissionAllowed,
  rateLimiter,
  revealInput,
  vscodeRemoteUrl,
  windowOpenDecision,
} from './policy.js'

const REMOTE_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), '..', 'preload', 'remote.cjs')

/** Caption colours before the page reports its own (the client's sidebar fill). */
function fallbackCaption() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#1b1b1c', symbolColor: '#f9fafb' }
    : { color: '#f9fafb', symbolColor: '#0f1115' }
}

/**
 * @typedef {object} RemoteView
 * @property {WebContentsView} view
 * @property {string} name
 * @property {number | undefined} port   the forward this view is pointed at.
 * @property {import('./policy.js').AuthStage} stage
 * @property {boolean} authFailed
 * @property {{ color: string, symbolColor: string } | undefined} caption  the page's own caption colours.
 */

export class RemoteViews {
  /**
   * @param {object} options
   * @param {import('./connections.js').ConnectionManager} options.manager
   * @param {() => import('electron').BrowserWindow | undefined} options.host  the main window.
   * @param {() => void} options.onHide  the home page is showing again (restore its caption).
   * @param {() => void} [options.onShow]  a remote view now covers the home page.
   * @param {() => void} options.onViewAdded  a view was stacked on top (keep the manager dialog above it).
   * @param {(id: string) => void} options.onChange  view state changed (for the connection page).
   * @param {(line: string) => void} [options.trace]  diagnostics (smoke tests read these).
   * @param {object} options.actions  what the caption's application menu can do.
   * @param {() => void} options.actions.openManager
   * @param {(id: string) => void} options.actions.reconnect
   * @param {(id: string) => void} options.actions.restart  asks for confirmation itself.
   * @param {(id: string) => void} options.actions.testNotification
   * @param {() => void} options.actions.about
   * @param {() => void} options.actions.quit
   * @param {object} options.bridge  what the page bridge's calls do, once validated.
   * @param {(id: string, content: { title: string, body: string }) => void} options.bridge.notify
   * @param {(id: string, count: number) => void} options.bridge.setBadge
   */
  constructor(options) {
    this.manager = options.manager
    this.host = options.host
    this.onHide = options.onHide
    this.onShow = options.onShow
    this.onViewAdded = options.onViewAdded
    this.onChange = options.onChange
    this.trace = options.trace ?? (() => {})
    this.actions = options.actions
    this.bridge = options.bridge
    /** @type {Map<string, RemoteView>} */
    this.views = new Map()
    /** The connection whose view is showing, or undefined for the home page. */
    /** @type {string | undefined} */
    this.active = undefined
    /** Partitions whose session handlers are installed (once per session). */
    this.configured = new Set()
    /** Same-origin preview windows, whose editors also receive native menu commands. */
    this.popupContents = new Set()
    this.#registerCaptionIpc()
    this.#registerBridgeIpc()
  }

  // ------------------------------------------------------------ show and hide

  /**
   * Show a connection's view over the home page, creating it when needed.
   * @param {string} id
   */
  open(id) {
    const host = this.host()
    if (host === undefined || host.isDestroyed()) return
    let entry = this.views.get(id)
    if (entry === undefined) entry = this.#create(id, host)
    for (const [other, { view }] of this.views) view.setVisible(other === id)
    this.active = id
    this.onShow?.()
    this.layout()
    this.#applyCaption(entry)
    host.setTitle(this.#titleOf(entry))
    if (host.isMinimized()) host.restore()
    host.show()
    entry.view.webContents.focus()
    if (entry.port === undefined) this.load(id)
    this.onChange(id)
  }

  /** Reveal the home page: every remote view steps aside (and keeps running). */
  hide() {
    const previous = this.active
    this.active = undefined
    for (const { view } of this.views.values()) view.setVisible(false)
    const host = this.host()
    if (host !== undefined && !host.isDestroyed()) {
      host.webContents.focus()
      this.onHide()
    }
    if (previous !== undefined) this.onChange(previous)
  }

  /** Fit the views to the window's content area. */
  layout() {
    const host = this.host()
    if (host === undefined || host.isDestroyed()) return
    const [width, height] = host.getContentSize()
    for (const { view } of this.views.values()) view.setBounds({ x: 0, y: 0, width, height })
  }

  /** @param {string} id */
  info(id) {
    const entry = this.views.get(id)
    return {
      open: entry !== undefined,
      visible: this.active === id,
      authFailed: entry?.authFailed ?? false,
    }
  }

  /**
   * Release one connection's view (the connection was removed).
   * @param {string} id
   */
  close(id) {
    const entry = this.views.get(id)
    if (entry === undefined) return
    if (this.active === id) this.hide()
    this.views.delete(id)
    const host = this.host()
    if (host !== undefined && !host.isDestroyed()) host.contentView.removeChildView(entry.view)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
  }

  /** Release every view (app exit). */
  closeAll() {
    for (const { view } of this.views.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    this.views.clear()
    this.active = undefined
  }

  /** Route native menu edits to a remote editor, without touching the manager. */
  editFocused(contents, command) {
    const entry = [...this.views.values()].find(({ view }) => view.webContents === contents)
    if (entry === undefined && !this.popupContents.has(contents)) return false
    const { keyCode, modifiers } = editingShortcut(command)
    this.#sendEditingKey(contents, keyCode, modifiers)
    return true
  }

  /** A reload of a managed view starts the existing 401 recovery state machine. */
  reloadFocused(contents) {
    const found = [...this.views].find(([, { view }]) => view.webContents === contents)
    if (found !== undefined) {
      this.load(found[0])
      return true
    }
    return false
  }

  /**
   * @param {string} id
   * @param {import('electron').BrowserWindow} host
   * @returns {RemoteView}
   */
  #create(id, host) {
    const partition = partitionFor(id)
    this.#configurePartition(id, partition)
    const name = this.manager.list().find((c) => c.id === id)?.name ?? id
    const view = new WebContentsView({
      webPreferences: {
        preload: REMOTE_PRELOAD,
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        spellcheck: false,
      },
    })
    view.setBackgroundColor(fallbackCaption().color)
    host.contentView.addChildView(view)
    this.onViewAdded()
    /** @type {RemoteView} */
    const entry = { view, name, port: undefined, stage: 'base', authFailed: false, caption: undefined }
    this.views.set(id, entry)
    this.#guard(id, entry)
    const contents = view.webContents
    contents.on('context-menu', (_event, params) => {
      const items = contextMenuItems(params)
      if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: host })
    })
    contents.on('page-title-updated', () => {
      if (this.active === id && !host.isDestroyed()) host.setTitle(this.#titleOf(entry))
    })
    this.#installShortcuts(contents, () => { this.load(id) })
    return entry
  }

  /** Remote editors handle their own history, including native menu replays. */
  #installShortcuts(contents, reload) {
    contents.on('before-input-event', (event, input) => {
      // Ignoring only editing accelerators avoids recursive menu dispatch when
      // a menu click sends Cmd+Z back into the editor. Other shortcuts (Cmd+Q,
      // Cmd+W, etc.) continue through the native application menu normally.
      if (process.platform === 'darwin') contents.setIgnoreMenuShortcuts(isEditingShortcut(input))
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      const developerShortcut = process.platform === 'darwin'
        ? input.meta && input.alt && !input.control && !input.shift && key === 'i'
        : input.control && input.shift && !input.meta && !input.alt && key === 'i'
      const reloadShortcut = (process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)
        && !input.shift && !input.alt && key === 'r'
      if (key === 'f12' || developerShortcut) {
        event.preventDefault()
        contents.toggleDevTools()
      } else if (key === 'f5' || reloadShortcut) {
        event.preventDefault()
        reload()
      }
    })
  }

  /** @param {RemoteView} entry */
  #titleOf(entry) {
    const title = entry.view.webContents.getTitle()
    const page = title === '' || /^https?:\/\//.test(title) ? 'DSH' : title
    return `${page} — ${entry.name}`
  }

  /** @param {RemoteView} entry */
  #applyCaption(entry) {
    if (process.platform === 'darwin') return
    const host = this.host()
    if (host === undefined || host.isDestroyed()) return
    host.setTitleBarOverlay({ ...(entry.caption ?? fallbackCaption()), height: TITLEBAR_HEIGHT })
  }

  // ------------------------------------------------------------------ loading

  /**
   * Point a view at the connection's forward, starting at the clean root.
   * Called when it opens and whenever the connection (re)reaches ready.
   * @param {string} id
   */
  load(id) {
    const entry = this.views.get(id)
    if (entry === undefined) return
    const port = this.manager.boundPort(id)
    entry.port = port
    entry.authFailed = false
    entry.stage = 'base'
    if (port !== undefined) {
      this.trace(`load ${id} base`)
      void entry.view.webContents.loadURL(baseUrl(port)).catch(() => { /* reported through did-fail-load */ })
    }
    this.onChange(id)
  }

  /**
   * A connection reached ready: an existing view follows it to the (possibly
   * new) forward.
   * @param {string} id
   */
  onReady(id) {
    if (this.views.has(id)) this.load(id)
  }

  // ------------------------------------------------------------- caption IPC

  /**
   * The remote view a caption IPC came from, or undefined. Only the top frame
   * of one of our views, while it shows the app origin, may ask.
   * @param {import('electron').IpcMainEvent | import('electron').IpcMainInvokeEvent} event
   * @returns {[string, RemoteView] | undefined}
   */
  #callerOf(event) {
    for (const [id, entry] of this.views) {
      const contents = entry.view.webContents
      if (contents.isDestroyed() || event.sender !== contents) continue
      const allowed = isBridgeCaller({
        fromOwnView: true,
        isMainFrame: event.senderFrame === contents.mainFrame,
        frameUrl: event.senderFrame?.url,
        port: entry.port,
      })
      return allowed ? [id, entry] : undefined
    }
    return undefined
  }

  /**
   * `window.dshSshDesktop`: every call is checked for its caller (see
   * `policy.isBridgeCaller`) and its arguments before anything happens.
   */
  #registerBridgeIpc() {
    const handle = (channel, fn) => {
      ipcMain.handle(channel, async (event, ...args) => {
        const caller = this.#callerOf(event)
        if (caller === undefined) throw new Error('refused: not a DSH page shown by this app')
        await fn(caller[0], ...args)
      })
    }
    const notifyAllowed = new Map()
    handle('dsh-bridge:notify', (id, input) => {
      const content = notifyInput(input)
      if (!notifyAllowed.has(id)) notifyAllowed.set(id, rateLimiter(5, 60_000))
      if (!notifyAllowed.get(id)()) throw new Error('refused: too many notifications')
      this.bridge.notify(id, content)
    })
    handle('dsh-bridge:setBadge', (id, count) => { this.bridge.setBadge(id, badgeInput(count)) })
    const revealAllowed = new Map()
    handle('dsh-bridge:revealInEditor', async (id, input) => {
      const { path, line } = revealInput(input)
      if (!revealAllowed.has(id)) revealAllowed.set(id, rateLimiter(10, 60_000))
      if (!revealAllowed.get(id)()) throw new Error('refused: too many requests')
      const target = this.manager.list().find((c) => c.id === id)?.target
      if (target === undefined) throw new Error('refused: unknown connection')
      await shell.openExternal(vscodeRemoteUrl(target, path, line))
    })
  }

  #registerCaptionIpc() {
    ipcMain.handle('dsh-remote:menu', (event, name, x, y) => {
      const caller = this.#callerOf(event)
      if (caller === undefined) throw new Error('refused: not a remote view')
      if (!isMenuRequest(name, x, y)) throw new Error('refused: invalid menu request')
      const host = this.host()
      if (host === undefined || host.isDestroyed()) return undefined
      const [id, entry] = caller
      const items = name === 'application'
        ? this.#applicationItems(id)
        : remoteEditItems((keyCode, modifiers) => { this.#sendKey(entry, keyCode, modifiers) })
      return popupAt(host, entry.view.webContents, items, x, y)
    })
    ipcMain.on('dsh-remote:appearance', (event, color, symbolColor) => {
      const caller = this.#callerOf(event)
      if (caller === undefined || !isCaptionColor(color) || !isCaptionColor(symbolColor)) return
      const [id, entry] = caller
      entry.caption = { color, symbolColor }
      if (this.active === id) this.#applyCaption(entry)
    })
  }

  /**
   * The caption's application menu over a remote view.
   * @param {string} id
   * @returns {import('electron').MenuItemConstructorOptions[]}
   */
  #applicationItems(id) {
    const m = messages()
    return [
      { label: m.connections, click: () => { this.actions.openManager() } },
      ...this.#connectionItems(id),
      { type: 'separator' },
      { label: m.about, click: () => { this.actions.about() } },
      { label: m.exit, click: () => { this.actions.quit() } },
    ]
  }

  /** Native macOS connection menu, refreshed when the visible server changes. */
  applicationItems() {
    if (this.active === undefined) return this.showItems()
    return [
      { label: `${messages().currentServer}: ${this.views.get(this.active)?.name ?? this.active}`, enabled: false },
      ...this.#connectionItems(this.active),
    ]
  }

  /** Connection actions shared by the caption and macOS application menus. */
  #connectionItems(id) {
    const m = messages()
    return [
      ...this.#switchItems(id),
      { type: 'separator' },
      // macOS has one focused-content reload accelerator in the View menu.
      { id: `${id}:reload`, label: m.reloadPage, ...(process.platform === 'darwin' ? {} : { accelerator: 'Ctrl+R', registerAccelerator: false }), click: () => { this.load(id) } },
      { id: `${id}:reconnect`, label: m.reconnect, click: () => { this.actions.reconnect(id) } },
      { id: `${id}:restart`, label: m.restartRemote, click: () => { this.actions.restart(id) } },
      { type: 'separator' },
      { id: `${id}:testNotification`, label: m.testNotification, click: () => { this.actions.testNotification(id) } },
    ]
  }

  /**
   * "Switch server" entries: every other connection that is ready.
   * @param {string | undefined} current
   * @returns {import('electron').MenuItemConstructorOptions[]}
   */
  #switchItems(current) {
    const others = this.manager.list().filter((c) => c.id !== current && this.manager.snapshot(c.id).phase === 'ready')
    if (others.length === 0) return []
    return [{
      label: messages().switchServer,
      submenu: others.map((c) => ({ id: `${c.id}:switch`, label: String(c.name), click: () => { this.open(c.id) } })),
    }]
  }

  /**
   * Menu entries that bring a ready connection's UI forward (the home page's
   * "back to DSH"): one per ready connection.
   * @returns {import('electron').MenuItemConstructorOptions[]}
   */
  showItems() {
    const ready = this.manager.list().filter((c) => this.manager.snapshot(c.id).phase === 'ready')
    const m = messages()
    if (ready.length <= 1) {
      return [{ id: `${ready[0]?.id ?? 'none'}:show`, label: m.openWindow, enabled: ready.length === 1, click: () => { if (ready[0] !== undefined) this.open(ready[0].id) } }]
    }
    return [{ label: m.openWindow, submenu: ready.map((c) => ({ id: `${c.id}:show`, label: String(c.name), click: () => { this.open(c.id) } })) }]
  }

  /**
   * Replay an editing shortcut into the page (upstream `sendEditingKey`).
   * @param {RemoteView} entry
   * @param {string} keyCode
   * @param {string[]} modifiers
   */
  #sendKey(entry, keyCode, modifiers) {
    this.#sendEditingKey(entry.view.webContents, keyCode, modifiers)
  }

  #sendEditingKey(contents, keyCode, modifiers) {
    if (contents.isDestroyed()) return
    contents.focus()
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }

  // ----------------------------------------------------------------- lockdown

  /**
   * Per-partition handlers. Permission decisions check the requesting origin
   * against the connection's *current* forward, so they stay right after a
   * reconnect lands on another port.
   * @param {string} id
   * @param {string} partition
   */
  #configurePartition(id, partition) {
    if (this.configured.has(partition)) return
    this.configured.add(partition)
    const ses = electronSession.fromPartition(partition)
    const currentPort = () => this.views.get(id)?.port ?? -1
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      const url = details?.requestingUrl ?? ''
      callback(permissionAllowed(permission, url, currentPort()))
    })
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      return permissionAllowed(permission, requestingOrigin, currentPort())
    })
    // Downloads from the remote UI go through the normal save dialog.
    ses.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: '保存文件' })
    })
  }

  /**
   * Navigation, popup and 401 handling for one view.
   * @param {string} id
   * @param {RemoteView} entry
   */
  #guard(id, entry) {
    const contents = entry.view.webContents
    const port = () => entry.port ?? -1

    const onNavigate = (event, url) => {
      const decision = navigationDecision(url, port())
      if (decision === 'allow') return
      event.preventDefault()
      if (decision === 'external') void shell.openExternal(url)
      this.trace(`navigation ${decision}: ${url}`)
    }
    contents.on('will-navigate', onNavigate)
    // Top frame only: subframes may load what the page embeds.
    contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) onNavigate(event, url)
    })

    contents.setWindowOpenHandler(({ url }) => {
      const decision = windowOpenDecision(url, port())
      if (decision === 'external') void shell.openExternal(url)
      if (decision !== 'allow') return { action: 'deny' }
      // A same-origin popup keeps the partition and the same lockdown.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
        },
      }
    })
    contents.on('did-create-window', (child) => {
      // Popups inherit the same rules; they have no auth state of their own.
      const childContents = child.webContents
      this.popupContents.add(childContents)
      childContents.once('destroyed', () => { this.popupContents.delete(childContents) })
      this.#installShortcuts(childContents, () => { childContents.reload() })
      childContents.on('will-navigate', onNavigate)
      childContents.on('will-redirect', onNavigate)
      childContents.setWindowOpenHandler(({ url }) => {
        if (windowOpenDecision(url, port()) === 'external') void shell.openExternal(url)
        return { action: 'deny' }
      })
    })

    contents.on('did-navigate', (_event, url, status) => {
      this.trace(`navigated ${String(status)} ${redactToken(url)}`)
      void this.#afterNavigate(id, entry, status)
    })
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 (ERR_ABORTED) is a load replaced by the next one, e.g. the token URL.
      if (!isMainFrame || code === -3) return
      // A dead forward: the manager reconnects and `onReady` reloads.
      this.trace(`load failed ${String(code)} ${description} ${redactToken(url)}`)
    })
  }

  /**
   * Run one step of the 401 recovery.
   * @param {string} id
   * @param {RemoteView} entry
   * @param {number} status
   */
  async #afterNavigate(id, entry, status) {
    const contents = entry.view.webContents
    const step = nextAuthStep(entry.stage, status)
    entry.stage = step.stage
    if (step.action === 'none') {
      if (entry.authFailed && step.stage === 'done') {
        entry.authFailed = false
        this.onChange(id)
      }
      return
    }
    if (step.action === 'load-token') {
      const url = this.manager.launchUrl(id)
      if (url !== undefined) {
        this.trace(`load ${id} token`)
        void contents.loadURL(url).catch(() => {})
        return
      }
      // No URL from the connect: go straight to the log.
      entry.stage = 'log'
    }
    if (step.action === 'reread-log' || entry.stage === 'log') {
      entry.stage = 'log'
      const result = await this.manager.refreshFromLog(id).catch((error) => ({ ok: false, message: String(error) }))
      const url = this.manager.launchUrl(id)
      if (result.ok && url !== undefined && !contents.isDestroyed()) {
        this.trace(`load ${id} log-token`)
        void contents.loadURL(url).catch(() => {})
        return
      }
    }
    entry.stage = 'failed'
    entry.authFailed = true
    this.trace(`auth failed ${id}`)
    this.onChange(id)
  }
}

/** Drop the launch token from a URL before it is logged. */
function redactToken(url) {
  return url.replace(/([?&]token=)[^&#]+/, '$1<redacted>')
}
