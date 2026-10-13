/**
 * Native application and context menus. macOS uses its global menu bar;
 * Windows uses caption buttons and a hidden menu for developer shortcuts,
 * following the official desktop (upstream apps/desktop/src/main.ts).
 *
 * @module dsh-ssh-desktop/menus
 */

import { Menu, app, webContents } from 'electron'

const MESSAGES = {
  zh: {
    application: '应用',
    edit: '编辑',
    connections: '连接管理',
    openWindow: '返回 DSH',
    reloadPage: '重新加载页面',
    reconnect: '重新连接',
    restartRemote: '重启远端…',
    testNotification: '测试通知',
    switchServer: '切换服务器',
    about: '关于 DSH 连接',
    exit: '退出',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    delete: '删除',
    selectAll: '全选',
    view: '视图',
    window: '窗口',
    developerTools: '开发者工具',
    currentServer: '当前服务器',
    showMainWindow: '显示主窗口',
  },
  en: {
    application: 'Application',
    edit: 'Edit',
    connections: 'Connections',
    openWindow: 'Back to DSH',
    reloadPage: 'Reload Page',
    reconnect: 'Reconnect',
    restartRemote: 'Restart Remote…',
    testNotification: 'Test Notification',
    switchServer: 'Switch Server',
    about: 'About DSH Connect',
    exit: 'Exit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    delete: 'Delete',
    selectAll: 'Select All',
    view: 'View',
    window: 'Window',
    developerTools: 'Developer Tools',
    currentServer: 'Current Server',
    showMainWindow: 'Show Main Window',
  },
}

/** The shell's copy in the system language (Chinese or English). */
export function messages() {
  return app.getLocale().toLowerCase().startsWith('zh') ? MESSAGES.zh : MESSAGES.en
}

/**
 * Edit commands for a remote page. The DSH editor keeps its own history and
 * listens for key events rather than Chromium's native edit commands, so each
 * item replays the shortcut into the page instead of using a menu role.
 * @param {(keyCode: string, modifiers: string[]) => void} sendKey
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function remoteEditItems(sendKey) {
  const m = messages()
  const item = (command) => {
    const { keyCode, modifiers, accelerator } = editingShortcut(command)
    return {
      label: m[command],
      ...(accelerator === undefined ? {} : { accelerator }),
      // The shortcut is only a label here; the page handles the real key.
      registerAccelerator: false,
      click: () => { sendKey(keyCode, modifiers) },
    }
  }
  return [
    item('undo'),
    item('redo'),
    { type: 'separator' },
    item('cut'),
    item('copy'),
    item('paste'),
    item('delete'),
    { type: 'separator' },
    item('selectAll'),
  ]
}

/** The remote editor owns its history, so menu commands replay platform keys. */
export function editingShortcut(command, platform = process.platform) {
  const mac = platform === 'darwin'
  const modifier = mac ? 'meta' : 'control'
  const prefix = mac ? 'Cmd' : 'Ctrl'
  if (command === 'delete') return { keyCode: mac ? 'Backspace' : 'Delete', modifiers: [] }
  if (command === 'redo') return mac
    ? { keyCode: 'Z', modifiers: ['meta', 'shift'], accelerator: 'Cmd+Shift+Z' }
    : { keyCode: 'Y', modifiers: ['control'], accelerator: 'Ctrl+Y' }
  const keyCode = { undo: 'Z', cut: 'X', copy: 'C', paste: 'V', selectAll: 'A' }[command]
  if (keyCode === undefined) throw new Error(`unknown editing command: ${String(command)}`)
  return { keyCode, modifiers: [modifier], accelerator: `${prefix}+${keyCode}` }
}

/** Let physical and replayed editing keys reach the remote editor once. */
export function isEditingShortcut(input, platform = process.platform) {
  if (input.alt) return false
  const key = input.key.toLowerCase()
  if (platform === 'darwin') return input.meta && !input.control
    && (key === 'z' || (!input.shift && ['x', 'c', 'v', 'a'].includes(key)))
  return input.control && !input.meta && !input.shift && ['z', 'y', 'x', 'c', 'v', 'a'].includes(key)
}

/**
 * Edit commands for the shell's own pages, which use native editing.
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function nativeEditItems() {
  const m = messages()
  return [
    { role: 'undo', label: m.undo },
    { role: 'redo', label: m.redo },
    { type: 'separator' },
    { role: 'cut', label: m.cut },
    { role: 'copy', label: m.copy },
    { role: 'paste', label: m.paste },
    { role: 'delete', label: m.delete },
    { type: 'separator' },
    { role: 'selectAll', label: m.selectAll },
  ]
}

/**
 * The right-click menu: editing commands in an editable field, copy for a
 * selection, nothing otherwise (as upstream).
 * @param {import('electron').ContextMenuParams} params
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function contextMenuItems(params) {
  const m = messages()
  const flags = params.editFlags
  // Empty accelerators keep Electron from printing default shortcut labels.
  if (params.isEditable) {
    return [
      { role: 'undo', label: m.undo, enabled: flags.canUndo, accelerator: '' },
      { role: 'redo', label: m.redo, enabled: flags.canRedo, accelerator: '' },
      { type: 'separator' },
      { role: 'cut', label: m.cut, enabled: flags.canCut, accelerator: '' },
      { role: 'copy', label: m.copy, enabled: flags.canCopy, accelerator: '' },
      { role: 'paste', label: m.paste, enabled: flags.canPaste, accelerator: '' },
      { type: 'separator' },
      { role: 'selectAll', label: m.selectAll, enabled: flags.canSelectAll, accelerator: '' },
    ]
  }
  if (params.selectionText.length > 0) {
    return [{ role: 'copy', label: m.copy, enabled: flags.canCopy, accelerator: '' }]
  }
  return []
}

/**
 * macOS uses its native menu bar. Commands target the focused WebContents,
 * which can be the manager, a remote view, or a popup. The connection menu is
 * refreshed only when its structure changes, not when a log line arrives.
 * Other platforms keep the caption menus and hidden developer shortcuts.
 *
 * @param {object} [actions]
 * @param {() => void} [actions.openManager]
 * @param {() => void} [actions.showMainWindow]
 * @param {() => void} [actions.about]
 * @param {() => import('electron').MenuItemConstructorOptions[]} [actions.connectionItems]
 * @param {(contents: import('electron').WebContents, command: string) => boolean} [actions.editRemote]
 * @param {(contents: import('electron').WebContents) => boolean} [actions.reloadRemote]
 * @returns {() => void} Call after connection/view state changes.
 */
export function installApplicationMenu(actions = {}) {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'toggleDevTools', visible: false },
      { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
      { role: 'reload', visible: false },
    ]))
    return () => {}
  }
  const withFocused = (fn) => {
    const contents = webContents.getFocusedWebContents()
    if (contents !== null && !contents.isDestroyed()) fn(contents)
  }
  const m = messages()
  const edit = (command) => ({
    label: m[command],
    accelerator: editingShortcut(command).accelerator,
    click: () => withFocused((contents) => {
      if (actions.editRemote?.(contents, command) !== true) contents[command]()
    }),
  })
  let previous = ''
  const refresh = () => {
    const template = [
      { label: app.name, submenu: [
        { label: m.about, click: () => { actions.about?.() } },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ] },
      { label: m.connections, submenu: [
        { label: m.connections, accelerator: 'Cmd+,', click: () => { actions.openManager?.() } },
        { label: m.showMainWindow, click: () => { actions.showMainWindow?.() } },
        { type: 'separator' },
        ...(actions.connectionItems?.() ?? []),
      ] },
      { label: m.edit, submenu: [
        edit('undo'), edit('redo'), { type: 'separator' },
        edit('cut'), edit('copy'), edit('paste'), edit('delete'),
        { type: 'separator' }, edit('selectAll'),
      ] },
      { label: m.view, submenu: [
        { label: m.reloadPage, accelerator: 'Cmd+R', click: () => withFocused((contents) => {
          if (actions.reloadRemote?.(contents) !== true) contents.reload()
        }) },
        { label: m.developerTools, accelerator: 'Cmd+Alt+I', click: () => withFocused((contents) => { contents.toggleDevTools() }) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ] },
      { label: m.window, submenu: [
        { role: 'minimize' }, { role: 'zoom' }, { role: 'close' },
        { type: 'separator' }, { role: 'front' },
      ] },
    ]
    // JSON omits callbacks. Connection items include IDs so callbacks are
    // replaced when the current server changes, even with identical labels.
    const signature = JSON.stringify(template)
    if (signature === previous) return
    previous = signature
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }
  refresh()
  return refresh
}

/**
 * Pop a menu under a caption button and resolve when it closes. Every page
 * fills the window from its top-left corner, so page coordinates are window
 * coordinates once scaled by that page's zoom.
 * @param {import('electron').BrowserWindow} window
 * @param {import('electron').WebContents} contents  the page that asked.
 * @param {import('electron').MenuItemConstructorOptions[]} items
 * @param {number} x CSS px from the page.
 * @param {number} y CSS px from the page.
 */
export function popupAt(window, contents, items, x, y) {
  const zoom = contents.getZoomFactor()
  return new Promise((resolve) => {
    Menu.buildFromTemplate(items).popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: () => resolve(undefined) })
  })
}
